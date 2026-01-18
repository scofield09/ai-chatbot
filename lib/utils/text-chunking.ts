import "server-only";

import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

export interface TextChunk {
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface ChunkOptions {
  maxChunkSize: number;
  overlap: number;
}

/**
 * Split text into chunks with overlap using LangChain's RecursiveCharacterTextSplitter
 * This provides better text splitting with intelligent boundary detection and avoids duplicates
 */
export async function chunkText(
  text: string,
  options: ChunkOptions = {
    maxChunkSize: 1000,
    overlap: 200,
  }
): Promise<TextChunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: options.maxChunkSize,
    chunkOverlap: options.overlap,
  });

  // Use splitText for simpler string array output
  const textChunks = await splitter.splitText(text);

  // Convert to TextChunk format with accurate indices
  const chunks: TextChunk[] = [];
  let currentIndex = 0;

  for (const chunkText of textChunks) {
    const trimmedText = chunkText.trim();
    
    if (trimmedText.length === 0) {
      continue;
    }

    // Find the start index in the original text
    const startIndex = text.indexOf(trimmedText, currentIndex);
    
    if (startIndex >= 0) {
      const endIndex = startIndex + trimmedText.length;
      chunks.push({
        text: trimmedText,
        startIndex,
        endIndex,
      });
      currentIndex = endIndex;
    } else {
      // Fallback: use currentIndex if exact match not found
      chunks.push({
        text: trimmedText,
        startIndex: currentIndex,
        endIndex: currentIndex + trimmedText.length,
      });
      currentIndex += trimmedText.length;
    }
  }

  return chunks;
}

