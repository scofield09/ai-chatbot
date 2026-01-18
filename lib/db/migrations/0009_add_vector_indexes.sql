-- Add vector indexes and metadata indexes for DocumentEmbedding table
-- This migration improves query performance for vector similarity search

--> statement-breakpoint
-- Create IVFFlat index for vector similarity search
-- IVFFlat is suitable for datasets with < 1 million vectors
-- Lists parameter: should be rows / 1000 for best performance (minimum 10)
CREATE INDEX IF NOT EXISTS "document_embedding_vector_idx" 
ON "DocumentEmbedding" 
USING ivfflat ((embedding::vector(1024)) vector_cosine_ops)
WITH (lists = 100);

--> statement-breakpoint
-- Alternative: HNSW index (uncomment if you have > 1 million vectors)
-- HNSW is faster but uses more storage space
-- CREATE INDEX IF NOT EXISTS "document_embedding_vector_hnsw_idx" 
-- ON "DocumentEmbedding" 
-- USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
-- WITH (m = 16, ef_construction = 64);

--> statement-breakpoint
-- Index for documentId (used in filtering and joins)
CREATE INDEX IF NOT EXISTS "document_embedding_document_id_idx" 
ON "DocumentEmbedding" ("documentId");

--> statement-breakpoint
-- Index for knowledgeBaseId (used in filtering)
CREATE INDEX IF NOT EXISTS "document_embedding_knowledge_base_id_idx" 
ON "DocumentEmbedding" ("knowledgeBaseId");

--> statement-breakpoint
-- Composite index for common query patterns (documentId + knowledgeBaseId)
CREATE INDEX IF NOT EXISTS "document_embedding_doc_kb_idx" 
ON "DocumentEmbedding" ("documentId", "knowledgeBaseId");

--> statement-breakpoint
-- Index for createdAt (useful for sorting and cleanup operations)
CREATE INDEX IF NOT EXISTS "document_embedding_created_at_idx" 
ON "DocumentEmbedding" ("createdAt");
