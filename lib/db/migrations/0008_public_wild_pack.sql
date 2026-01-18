CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "DocumentEmbedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documentId" uuid NOT NULL,
	"knowledgeBaseId" uuid,
	"chunkIndex" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "KnowledgeBase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
-- Note: Document table uses composite primary key (id, createdAt)
-- We skip the foreign key constraint for DocumentEmbedding -> Document
-- because Document uses a composite primary key. The application will handle referential integrity.
-- If you need referential integrity, create a unique index on Document.id first:
-- CREATE UNIQUE INDEX IF NOT EXISTS "Document_id_unique_idx" ON "Document"("id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "DocumentEmbedding" ADD CONSTRAINT "DocumentEmbedding_knowledgeBaseId_KnowledgeBase_id_fk" FOREIGN KEY ("knowledgeBaseId") REFERENCES "public"."KnowledgeBase"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;