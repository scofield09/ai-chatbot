-- Migration to change embedding dimension from 1536 (OpenAI) to 1024 (ZhipuAI embedding-3)
-- Run this SQL script to update the existing database

-- First, drop the existing column (this will delete all existing embeddings)
-- If you want to keep existing data, you'll need to export and re-import with new dimensions
ALTER TABLE "DocumentEmbedding" DROP COLUMN IF EXISTS "embedding";

-- Recreate the column with the correct dimension
ALTER TABLE "DocumentEmbedding" ADD COLUMN "embedding" vector(1024) NOT NULL;

-- Alternative: If you want to keep existing data, you can try to cast (may fail if dimensions don't match)
-- ALTER TABLE "DocumentEmbedding" ALTER COLUMN "embedding" TYPE vector(1024) USING embedding::vector(1024);
