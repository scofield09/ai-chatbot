-- Manual migration script to add vector indexes
-- Run this directly if you want to add indexes without using drizzle-kit
-- Usage: psql $POSTGRES_URL -f lib/db/migrate-vector-indexes.sql

-- Ensure pgvector extension is installed
CREATE EXTENSION IF NOT EXISTS vector;

-- Create IVFFlat index for vector similarity search
-- IVFFlat is suitable for datasets with < 1 million vectors
-- Lists parameter: should be rows / 1000 for best performance (minimum 10)
-- Adjust lists based on your data size:
--   - < 100k vectors: lists = 100
--   - 100k - 500k: lists = 500
--   - 500k - 1M: lists = 1000
CREATE INDEX IF NOT EXISTS document_embedding_vector_idx 
ON "DocumentEmbedding" 
USING ivfflat ((embedding::vector(1024)) vector_cosine_ops)
WITH (lists = 100);

-- Alternative: HNSW index (uncomment if you have > 1 million vectors)
-- HNSW is faster for queries but uses more storage space
-- CREATE INDEX IF NOT EXISTS document_embedding_vector_hnsw_idx 
-- ON "DocumentEmbedding" 
-- USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
-- WITH (m = 16, ef_construction = 64);

-- Index for documentId (used in filtering and joins)
CREATE INDEX IF NOT EXISTS document_embedding_document_id_idx 
ON "DocumentEmbedding" ("documentId");

-- Index for knowledgeBaseId (used in filtering)
CREATE INDEX IF NOT EXISTS document_embedding_knowledge_base_id_idx 
ON "DocumentEmbedding" ("knowledgeBaseId");

-- Composite index for common query patterns (documentId + knowledgeBaseId)
CREATE INDEX IF NOT EXISTS document_embedding_doc_kb_idx 
ON "DocumentEmbedding" ("documentId", "knowledgeBaseId");

-- Index for createdAt (useful for sorting and cleanup operations)
CREATE INDEX IF NOT EXISTS document_embedding_created_at_idx 
ON "DocumentEmbedding" ("createdAt");

-- Verify indexes were created
SELECT 
    indexname, 
    indexdef 
FROM pg_indexes 
WHERE tablename = 'DocumentEmbedding'
ORDER BY indexname;
