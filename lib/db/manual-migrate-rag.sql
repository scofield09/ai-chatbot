-- Manual migration for RAG tables
-- Run this if drizzle-kit migration fails

-- Create pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create KnowledgeBase table
CREATE TABLE IF NOT EXISTS "KnowledgeBase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"createdAt" timestamp NOT NULL
);

-- Create DocumentEmbedding table
CREATE TABLE IF NOT EXISTS "DocumentEmbedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documentId" uuid NOT NULL,
	"knowledgeBaseId" uuid,
	"chunkIndex" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"createdAt" timestamp NOT NULL
);

-- Add foreign key constraints (with error handling)
DO $$ BEGIN
 ALTER TABLE "DocumentEmbedding" ADD CONSTRAINT "DocumentEmbedding_documentId_Document_id_fk" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "DocumentEmbedding" ADD CONSTRAINT "DocumentEmbedding_knowledgeBaseId_KnowledgeBase_id_fk" FOREIGN KEY ("knowledgeBaseId") REFERENCES "public"."KnowledgeBase"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Drop lastContext column if it exists (from previous migration)
ALTER TABLE "Chat" DROP COLUMN IF EXISTS "lastContext";

