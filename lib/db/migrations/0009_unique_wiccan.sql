ALTER TABLE "DocumentEmbedding" ADD COLUMN "documentTitle" text;--> statement-breakpoint
ALTER TABLE "DocumentEmbedding" ADD COLUMN "userId" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "DocumentEmbedding" ADD CONSTRAINT "DocumentEmbedding_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
