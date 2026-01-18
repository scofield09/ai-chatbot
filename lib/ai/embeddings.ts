import "server-only";

/**
 * Generate embedding for a single text using ZhipuAI
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.ZHIPUAI_API_KEY;
  if (!apiKey) {
    throw new Error("ZHIPUAI_API_KEY environment variable is not set");
  }

  const response = await fetch("https://open.bigmodel.cn/api/paas/v4/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "embedding-3",
      input: text,
      dimensions: 1024, // embedding-3 supports custom dimensions: 256, 512, 1024, 2048
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `ZhipuAI API error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = await response.json();
  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error("Invalid response from ZhipuAI API");
  }

  return data.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts (more efficient) using ZhipuAI
 * ZhipuAI API has a limit of 64 items per batch request
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const apiKey = process.env.ZHIPUAI_API_KEY;
  if (!apiKey) {
    throw new Error("ZHIPUAI_API_KEY environment variable is not set");
  }

  const BATCH_SIZE = 64; // ZhipuAI API limit
  const allEmbeddings: number[][] = [];

  // Process texts in batches of 64
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetch("https://open.bigmodel.cn/api/paas/v4/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "embedding-3",
        input: batch,
        dimensions: 1024, // embedding-3 supports custom dimensions: 256, 512, 1024, 2048
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `ZhipuAI API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = await response.json();
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response from ZhipuAI API");
    }

    // Extract embeddings from this batch
    const batchEmbeddings = data.data.map((item: { embedding: number[] }) => item.embedding);
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}

