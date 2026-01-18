import "server-only";

import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { TextLoader } from "langchain/document_loaders/fs/text";

export interface ExtractedText {
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Extract text content from a file buffer based on file type
 */
export async function extractTextFromFile(
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string
): Promise<ExtractedText> {
  // Create temporary file path
  const tempFilePath = join(tmpdir(), `upload-${Date.now()}-${fileName}`);

  try {
    // Write buffer to temporary file
    await writeFile(tempFilePath, Buffer.from(fileBuffer));

    let text = "";
    let metadata: Record<string, unknown> = {};

    // Extract text based on file type
    if (mimeType === "application/pdf") {
      const loader = new PDFLoader(tempFilePath);
      const docs = await loader.load();
      text = docs.map((doc) => doc.pageContent).join("\n");
      metadata = {
        pageCount: docs.length,
        ...(docs[0]?.metadata || {}),
      };
    } else if (
      mimeType === "text/plain" ||
      mimeType === "text/markdown" ||
      fileName.endsWith(".txt") ||
      fileName.endsWith(".md")
    ) {
      const loader = new TextLoader(tempFilePath);
      const docs = await loader.load();
      text = docs.map((doc) => doc.pageContent).join("\n");
      metadata = docs[0]?.metadata || {};
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`);
    }

    return { text, metadata };
  } finally {
    // Clean up temporary file
    try {
      await unlink(tempFilePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

