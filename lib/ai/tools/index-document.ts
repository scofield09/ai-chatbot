import "server-only";

import { tool, type UIMessageStreamWriter } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { generateEmbeddings } from "@/lib/ai/embeddings";
import {
  deleteDocumentEmbeddings,
  getDocumentById,
  saveDocumentEmbeddings,
} from "@/lib/db/queries";
import type { ChatMessage } from "@/lib/types";
import { chunkText } from "@/lib/utils/text-chunking";
import { cleanTextForEmbedding } from "@/lib/utils/text-cleaning";

type IndexDocumentProps = {
  session: Session;
  dataStream: UIMessageStreamWriter<ChatMessage>;
};

export const indexDocument = ({
  session,
  dataStream,
}: IndexDocumentProps) =>
  tool({
    description:
      "Index a document into the knowledge base for RAG retrieval. Use this tool when the user explicitly asks to: add/store/save a document to the knowledge base, index a document, make a document searchable, or add a document for future reference. The document must already exist (created with createDocument). Always use this tool when the user mentions '知识库', '存储到知识库', '添加到知识库', '索引文档', or similar phrases in Chinese or English.",
    inputSchema: z.object({
      documentId: z.string().uuid().describe("The UUID of an existing document"),
      knowledgeBaseId: z
        .string()
        .uuid()
        .optional()
        .describe("Optional knowledge base ID to organize documents"),
    }),
    execute: async ({ documentId, knowledgeBaseId }) => {
      if (!session.user?.id) {
        return {
          error: "Unauthorized",
        };
      }

      const document = await getDocumentById({ id: documentId });

      if (!document || !document.content) {
        return {
          error: "Document not found or has no content",
        };
      }

      // Check if user owns the document
      if (document.userId !== session.user.id) {
        return {
          error: "You don't have permission to index this document",
        };
      }

      try {
        // 1. Delete existing embeddings for this document (if re-indexing)
        await deleteDocumentEmbeddings({ documentId });

        // 2. Split document into chunks using LangChain's text splitter
        const chunks = await chunkText(document.content, {
          maxChunkSize: 1000,
          overlap: 200,
        });

        // Remove duplicate chunks (same text content)
        const uniqueChunks = chunks.filter(
          (chunk, index, self) =>
            index === self.findIndex((c) => c.text.trim() === chunk.text.trim())
        );

        if (uniqueChunks.length === 0) {
          return {
            error: "Document content is too short to index",
          };
        }

        // 3. Clean text before generating embeddings to improve quality
        const cleanedChunks = uniqueChunks.map((chunk) => ({
          ...chunk,
          text: cleanTextForEmbedding(chunk.text),
        })).filter((chunk) => chunk.text.length > 0); // Remove empty chunks after cleaning

        if (cleanedChunks.length === 0) {
          return {
            error: "Document content is empty after cleaning",
          };
        }

        // 4. Generate embeddings for all cleaned chunks
        const embeddings = await generateEmbeddings(
          cleanedChunks.map((chunk) => chunk.text)
        );

        // 5. Save embeddings to database
        await saveDocumentEmbeddings({
          embeddings: cleanedChunks.map((chunk, index) => ({
            documentId,
            knowledgeBaseId,
            chunkIndex: index,
            content: chunk.text,
            embedding: embeddings[index],
          })),
        });

        return {
          success: true,
          chunksIndexed: cleanedChunks.length,
          message: `Successfully indexed ${cleanedChunks.length} chunks from document "${document.title}"`,
        };
      } catch (error) {
        console.error("Error indexing document:", error);
        return {
          error: "Failed to index document",
        };
      }
    },
  });

