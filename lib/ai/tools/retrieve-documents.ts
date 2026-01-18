import "server-only";

import { tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { generateEmbedding } from "@/lib/ai/embeddings";
import { searchSimilarDocuments } from "@/lib/db/queries";
import { cleanQueryText } from "@/lib/utils/text-cleaning";

type RetrieveDocumentsProps = {
  session: Session;
};

export const retrieveDocuments = ({ session }: RetrieveDocumentsProps) =>
  tool({
    description:
      "Search the knowledge base for relevant documents based on a query. Use this when the user asks questions that might be answered by their indexed documents. This tool retrieves relevant document chunks that can be used as context to answer the question.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("The search query to find relevant documents"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum number of results to return"),
      knowledgeBaseId: z
        .string()
        .uuid()
        .optional()
        .describe("Optional knowledge base ID to search within"),
    }),
    execute: async ({ query, limit, knowledgeBaseId }) => {
      if (!session.user?.id) {
        return {
          error: "Unauthorized",
          results: [],
        };
      }

      try {
        // 1. Clean query text to remove noise before generating embedding
        const cleanedQuery = cleanQueryText(query);
        
        if (!cleanedQuery || cleanedQuery.trim().length === 0) {
          return {
            error: "Query is empty after cleaning",
            results: [],
          };
        }

        // 2. Generate embedding for the cleaned query
        const queryEmbedding = await generateEmbedding(cleanedQuery);

        // 3. Search for similar documents
        const results = await searchSimilarDocuments({
          embedding: queryEmbedding,
          limit,
          knowledgeBaseId,
          similarityThreshold: 0.7,
          userId: session.user.id,
        });

        // 4. Format results
        return {
          results: results.map((result) => ({
            documentId: result.documentId,
            documentTitle: result.documentTitle,
            content: result.content,
            similarity: Math.round(result.similarity * 100) / 100,
            chunkIndex: result.chunkIndex,
          })),
          count: results.length,
          query,
        };
      } catch (error) {
        console.error("Error retrieving documents:", error);
        return {
          error: "Failed to retrieve documents",
          results: [],
        };
      }
    },
  });

