import "server-only";

import { generateEmbedding } from "@/lib/ai/embeddings";
import type { RetrievedDocument } from "@/lib/ai/prompts";
import { searchSimilarDocuments } from "@/lib/db/queries";
import type { ChatMessage } from "@/lib/types";
import { getTextFromMessage, generateUUID } from "@/lib/utils";
import { cleanQueryText } from "@/lib/utils/text-cleaning";

type RetrieveContextParams = {
  message: ChatMessage | undefined;
  uiMessages: ChatMessage[];
  userId: string | undefined;
  isToolApprovalFlow: boolean;
};

type RetrieveContextResult = {
  updatedMessages: ChatMessage[];
  retrievedDocuments: RetrievedDocument[];
};

/**
 * 自动从向量数据库检索相关文档
 * 在流式响应之前完成，避免阻塞并允许并行处理
 */
export async function retrieveRelevantContext({
  message,
  uiMessages,
  userId,
  isToolApprovalFlow,
}: RetrieveContextParams): Promise<RetrieveContextResult> {
  let retrievedDocuments: RetrievedDocument[] = [];
  let updatedMessages = uiMessages;

  console.log("\n=== 📚 RAG 检索开始 ===");

  // 只在用户消息、已登录且非工具审批流程时进行检索
  if (message?.role === "user" && userId && !isToolApprovalFlow) {
    try {
      const userMessageText = getTextFromMessage(message);

      if (userMessageText && userMessageText.trim().length > 0) {
        // 清理并生成查询的向量嵌入
        const cleanedQuery = cleanQueryText(userMessageText);

        if (cleanedQuery && cleanedQuery.trim().length > 0) {
          const queryEmbedding = await generateEmbedding(cleanedQuery);

          // 搜索相似文档
          const queryLength = cleanedQuery.length;
          const dynamicThreshold = 0.0; // 临时设为 0 用于调试

          const searchResults = await searchSimilarDocuments({
            embedding: queryEmbedding,
            limit: 3,
            knowledgeBaseId: undefined,
            similarityThreshold: dynamicThreshold,
            userId,
          });

          retrievedDocuments = searchResults.map((result) => ({
            documentId: result.documentId,
            documentTitle: result.documentTitle || result.documentId, // 如果没有标题，使用 documentId
            content: result.content,
            similarity: result.similarity,
            chunkIndex: result.chunkIndex,
          }));

          if (retrievedDocuments.length > 0) {
            // 过滤并按相似度排序文档（仅包含高质量匹配）
            const highQualityDocs = retrievedDocuments
              .filter((doc) => doc.similarity >= 0.0) // 临时设为 0 用于调试
              .sort((a, b) => b.similarity - a.similarity);

            if (highQualityDocs.length > 0) {
              // 格式化检索到的文档并添加到消息流
              // 使用紧凑格式以节省 token 同时保持清晰度
              const documentsText = highQualityDocs
                .map(
                  (doc, index) =>
                    `📄 **${doc.documentTitle}** (${(doc.similarity * 100).toFixed(0)}% relevant)
${doc.content}`
                )
                .join("\n\n---\n\n");

              const documentsMessage: ChatMessage = {
                id: generateUUID(),
                role: "system",
                parts: [
                  {
                    type: "text",
                    text: `**Knowledge Base Context** (${highQualityDocs.length} relevant document${highQualityDocs.length > 1 ? "s" : ""}):

${documentsText}

*Use information from these documents to answer the user's question. Cite the document title when referencing specific information.*`,
                  },
                ],
              };

              // 在用户当前消息之前插入文档消息
              updatedMessages = [
                ...uiMessages.slice(0, -1),
                documentsMessage,
                uiMessages[uiMessages.length - 1],
              ];

              console.log(documentsMessage, 'documentsMessage----->')

            }
          }
        }
      }
    } catch (error) {
      // 记录错误但不让请求失败 - 继续处理而不使用检索到的文档
      console.error("❌ 检索文档时出错:", error);
      if (error instanceof Error) {
        console.error("错误详情:", error.message);
        console.error("错误堆栈:", error.stack);
      }
    }
  } else {
    console.log("⚠️ 跳过 RAG 检索（条件不满足）");
  }

  console.log("=== 📚 RAG 检索结束 ===\n");

  return {
    updatedMessages,
    retrievedDocuments,
  };
}
