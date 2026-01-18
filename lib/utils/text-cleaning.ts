import "server-only";

/**
 * Clean text by removing characters and content that don't contribute to semantics
 * This helps improve embedding quality by focusing on meaningful content
 */
export function cleanTextForEmbedding(text: string): string {
  if (!text || text.length === 0) {
    return "";
  }

  let cleaned = text;

  // 1. Remove excessive whitespace (multiple spaces, tabs, newlines)
  // Keep single spaces and newlines for sentence/paragraph structure
  cleaned = cleaned.replace(/[ \t]+/g, " "); // Multiple spaces/tabs -> single space
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n"); // 3+ newlines -> double newline
  cleaned = cleaned.replace(/[ \t]+/g, " "); // Clean up again after newline normalization

  // 2. Remove control characters (except newline and tab)
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");

  // 3. Remove zero-width characters (often used for formatting but no semantic value)
  cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // 4. Remove excessive punctuation (keep meaningful punctuation)
  // Keep: . ! ? , ; : - ( ) [ ] { } " ' 
  // Remove: excessive dots, dashes, etc.
  cleaned = cleaned.replace(/\.{4,}/g, "..."); // 4+ dots -> ellipsis
  cleaned = cleaned.replace(/-{3,}/g, "--"); // 3+ dashes -> double dash
  cleaned = cleaned.replace(/_{3,}/g, "__"); // 3+ underscores -> double underscore

  // 5. Remove URLs (they can be noisy for semantic search, but keep domain names if needed)
  // For now, we'll keep URLs but could remove them if needed:
  // cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, "");

  // 6. Remove email addresses (optional, uncomment if needed)
  // cleaned = cleaned.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "");

  // 7. Remove excessive special characters that don't contribute to meaning
  // Keep common punctuation, remove decorative/formatting characters
  cleaned = cleaned.replace(/[※★☆◆◇○●△▲▽▼■□]/g, ""); // Remove decorative symbols

  // 8. Normalize quotes (convert fancy quotes to standard quotes)
  cleaned = cleaned.replace(/[""]/g, '"'); // Left/right double quotes -> standard
  cleaned = cleaned.replace(/['']/g, "'"); // Left/right single quotes -> standard

  // 9. Remove leading/trailing whitespace from each line
  cleaned = cleaned
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  // 10. Remove empty lines (keep at most one empty line between paragraphs)
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, "\n\n");

  // 11. Final trim
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Clean text specifically for query/search purposes
 * More aggressive cleaning for user queries
 */
export function cleanQueryText(text: string): string {
  if (!text || text.length === 0) {
    return "";
  }

  let cleaned = cleanTextForEmbedding(text);

  // Additional cleaning for queries:
  // Remove common query noise words/phrases (optional, can be customized)
  // For now, we'll keep all words but could add stop word removal if needed

  // Remove excessive question marks or exclamation marks
  cleaned = cleaned.replace(/[?!]{3,}/g, (match) => match.slice(0, 2));

  return cleaned;
}
