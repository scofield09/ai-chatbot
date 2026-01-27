import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { setFileContent } from "@/lib/redis/file-cache";
import { generateUUID } from "@/lib/utils";
import { truncateTextByTokens, estimateTokenCount } from "@/lib/utils/token-counter";
import { extractTextFromFile } from "@/lib/utils/file-extraction";

// 文件大小限制：500KB
const MAX_FILE_SIZE = 500 * 1024; // 512000 bytes

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= MAX_FILE_SIZE, {
      message: "文件大小不能超过 500KB",
    })
    .refine(
      (file) =>
        ["application/pdf", "text/plain", "text/markdown"].includes(file.type),
      {
        message: "只支持 PDF、TXT、MD 格式",
      }
    ),
});

// 使用 @/lib/utils/file-extraction 中的 extractTextFromFile 函数

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("请求体为空", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      return NextResponse.json({ error: "未选择文件" }, { status: 400 });
    }

    // 验证文件
    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // 获取文件名
    const filename = (formData.get("file") as File).name;
    const fileType = file.type;

    console.log(`📄 Processing file upload: ${filename} (${file.size} bytes)`);

    // 1. 提取文本内容
    let textContent: string;
    try {
      const fileBuffer = await file.arrayBuffer();
      const { text, metadata } = await extractTextFromFile(
        fileBuffer,
        filename,
        fileType
      );
      
      textContent = text;
      
      if (!textContent || textContent.length === 0) {
        return NextResponse.json(
          { error: "无法从文件中提取文本内容" },
          { status: 400 }
        );
      }

      console.log(
        `✅ Text extracted: ${textContent.length} characters`,
        metadata ? `(${JSON.stringify(metadata)})` : ""
      );
    } catch (error) {
      console.error("Text extraction error:", error);
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "文本提取失败",
        },
        { status: 400 }
      );
    }

    // 2. 智能截断文本（基于 token 数量）
    const originalTokens = estimateTokenCount(textContent);
    console.log(`📊 Original text: ${textContent.length} chars, ~${originalTokens} tokens`);

    const { text: truncatedText, truncated, finalTokens } = truncateTextByTokens(
      textContent,
      25000 // 最大 25k tokens
    );

    if (truncated) {
      console.log(
        `⚠️ Text truncated: ${originalTokens} → ${finalTokens} tokens (${textContent.length} → ${truncatedText.length} chars)`
      );
    }

    // 3. 上传原始文件到 Vercel Blob
    let blobUrl: string;
    try {
      // 重新获取文件 buffer（之前的已经用于文本提取）
      const uploadBuffer = await file.arrayBuffer();
      const data = await put(`${filename}`, uploadBuffer, {
        access: "public",
      });
      blobUrl = data.url;
      console.log(`✅ File uploaded to Blob: ${blobUrl}`);
    } catch (error) {
      console.error("Blob upload error:", error);
      return NextResponse.json(
        { error: "文件上传到云存储失败" },
        { status: 500 }
      );
    }

    // 4. 生成唯一的 fileId 并存储到 Redis
    const fileId = generateUUID();
    try {
      await setFileContent(fileId, truncatedText, 3600); // 1 小时过期
      console.log(`✅ File content cached in Redis: ${fileId}`);
    } catch (error) {
      console.error("Redis cache error:", error);
      // Redis 失败不影响主流程，继续返回成功
      console.warn("⚠️ Failed to cache in Redis, continuing without cache");
    }

    // 5. 返回结果
    return NextResponse.json({
      url: blobUrl,
      pathname: filename,
      contentType: fileType,
      fileId,
      size: file.size,
      textLength: truncatedText.length,
      estimatedTokens: finalTokens,
      wasTruncated: truncated,
      success: true,
    });
  } catch (error) {
    console.error("Upload API error:", error);
    return NextResponse.json(
      { error: "处理请求失败" },
      { status: 500 }
    );
  }
}
