import "server-only";

import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { generateEmbeddings } from "@/lib/ai/embeddings";
import {
  deleteDocumentEmbeddings,
  saveDocument,
  saveDocumentEmbeddings,
} from "@/lib/db/queries";
import { extractTextFromFile } from "@/lib/utils/file-extraction";
import { chunkText } from "@/lib/utils/text-chunking";
import { cleanTextForEmbedding } from "@/lib/utils/text-cleaning";
import { generateUUID } from "@/lib/utils";

const FileSchema = z.object({
  file: z.instanceof(Blob).refine((file) => file.size <= 5 * 1024 * 1024, {
    message: "File size should be less than 5MB",
  }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return NextResponse.json(
      { error: "Request body is empty" },
      { status: 400 }
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const filename = (formData.get("file") as File).name;
    const fileBuffer = await file.arrayBuffer();

    // Validate file size
    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // Validate file type
    const mimeType = file.type || "application/octet-stream";
    const isValidType =
      ["application/pdf", "text/plain", "text/markdown"].includes(mimeType) ||
      filename.endsWith(".pdf") ||
      filename.endsWith(".txt") ||
      filename.endsWith(".md");

    if (!isValidType) {
      return NextResponse.json(
        { error: "File type should be PDF, TXT, or MD" },
        { status: 400 }
      );
    }

    // Extract text content from file
    const { text, metadata } = await extractTextFromFile(
      fileBuffer,
      filename,
      mimeType
    );

    if (!text || text.trim().length === 0) {
      return NextResponse.json(
        { error: "File content is empty or could not be extracted" },
        { status: 400 }
      );
    }

    // Optionally upload file to blob storage (not required for RAG)
    // The text content is already extracted and will be stored in the database
    let blobUrl: string | undefined;
    try {
      const blobData = await put(filename, fileBuffer, {
        access: "public",
      });
      blobUrl = blobData.url;
    } catch (error) {
      // Blob upload is optional - log but don't fail
      console.warn("Failed to upload file to blob storage (optional):", error);
      // Continue without blob URL - text content is sufficient for RAG
    }

    // Create document record
    const documentId = generateUUID();
    const documentTitle = filename.replace(/\.[^/.]+$/, ""); // Remove extension

    try {
      await saveDocument({
        id: documentId,
        title: documentTitle,
        kind: "text",
        content: text,
        userId: session.user.id,
      });
    } catch (error) {
      console.error("Failed to save document:", error);
      return NextResponse.json(
        { error: "Failed to save document" },
        { status: 500 }
      );
    }

    // Automatically index the document
    try {
      console.log(`Starting indexing for document: ${documentId}, text length: ${text.length}`);

      // Delete existing embeddings if any (for re-indexing)
      await deleteDocumentEmbeddings({ documentId });

      // Split document into chunks using LangChain's text splitter
      const chunks = await chunkText(text, {
        maxChunkSize: 500,
        overlap: 50,
      });
      // Remove duplicate chunks (same text content)
      const uniqueChunks = chunks.filter(
        (chunk, index, self) =>
          index === self.findIndex((c) => c.text.trim() === chunk.text.trim())
      );
      console.log(
        `Document split into ${chunks.length} chunks, ${uniqueChunks.length} unique chunks after deduplication`
      );

      if (uniqueChunks.length === 0) {
        return NextResponse.json({
          success: true,
          documentId,
          title: documentTitle,
          blobUrl: blobUrl || undefined,
          message: "Document uploaded but content is too short to index",
          chunksIndexed: 0,
        });
      }

      // Generate embeddings for all unique chunks
      // Clean text before generating embeddings to improve quality
      console.log(`Generating embeddings for ${uniqueChunks.length} chunks...`);
      const cleanedChunks = uniqueChunks.map((chunk) => ({
        ...chunk,
        text: cleanTextForEmbedding(chunk.text),
      })).filter((chunk) => chunk.text.length > 0); // Remove empty chunks after cleaning
      
      if (cleanedChunks.length === 0) {
        return NextResponse.json({
          success: true,
          documentId,
          title: documentTitle,
          blobUrl: blobUrl || undefined,
          message: "Document uploaded but content is empty after cleaning",
          chunksIndexed: 0,
        });
      }

      const embeddings = await generateEmbeddings(
        cleanedChunks.map((chunk) => chunk.text)
      );
      console.log(`Generated ${embeddings.length} embeddings`);

      // Save embeddings to database
      console.log(`Saving embeddings to database...`);
      await saveDocumentEmbeddings({
        embeddings: cleanedChunks.map((chunk, index) => ({
          documentId,
          knowledgeBaseId: undefined,
          chunkIndex: index,
          content: chunk.text,
          embedding: embeddings[index],
        })),
      });
      console.log(`Successfully indexed document: ${documentId}`);

      return NextResponse.json({
        success: true,
        documentId,
        title: documentTitle,
        blobUrl: blobUrl || undefined,
        chunksIndexed: cleanedChunks.length,
        message: `Successfully uploaded and indexed ${cleanedChunks.length} chunks from "${documentTitle}"`,
      });
    } catch (error) {
      console.error("Failed to index document:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      // Document is saved but indexing failed - return partial success
      return NextResponse.json({
        success: true,
        documentId,
        title: documentTitle,
        blobUrl: blobUrl || undefined,
        chunksIndexed: 0,
        message: "Document uploaded but indexing failed",
        warning: "Document was saved but could not be indexed for search",
        error: process.env.NODE_ENV === "development" ? errorMessage : undefined,
      });
    }
  } catch (error) {
    console.error("Error processing document upload:", error);
    return NextResponse.json(
      { error: "Failed to process document upload" },
      { status: 500 }
    );
  }
}

