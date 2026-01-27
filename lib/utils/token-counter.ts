/**
 * Token 计数和管理工具
 * 用于估算文本的 token 数量，避免超出 LLM 的 context window
 */

/**
 * 估算文本的 token 数量
 *  
 * 简单估算规则（基于经验值）：
 * - 英文：约 1 token per 4 characters
 * - 中文：约 1 token per 1.5 characters 
 * - 混合文本：约 1 token per 2.5 characters（平均值）
 * 
 * 注意：这只是粗略估算，实际 token 数量取决于具体的 tokenizer
 */ 
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // 统计中文字符数量
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  // 统计非中文字符数量
  const otherChars = text.length - chineseChars;

  // 中文：1.5 字符/token，其他：4 字符/token
  const estimatedTokens = Math.ceil(chineseChars / 1.5 + otherChars / 4);

  return estimatedTokens;
}

/**
 * 智能截断文本，避免超出 token 限制
 * 
 * @param text 原始文本
 * @param maxTokens 最大 token 数量（默认 25000，约 100KB 文件）
 * @param addSuffix 是否添加截断提示后缀
 * @returns 截断后的文本
 */
export function truncateTextByTokens(
  text: string,
  maxTokens = 25000,
  addSuffix = true
): { text: string; truncated: boolean; originalTokens: number; finalTokens: number } {
  const originalTokens = estimateTokenCount(text);

  if (originalTokens <= maxTokens) {
    return {
      text,
      truncated: false,
      originalTokens,
      finalTokens: originalTokens,
    };
  }

  // 计算需要保留的字符数（粗略估算）
  const avgCharsPerToken = text.length / originalTokens;
  const maxChars = Math.floor(maxTokens * avgCharsPerToken);

  // 截断文本
  let truncatedText = text.slice(0, maxChars);

  // 尝试在句子边界截断，避免截断到句子中间
  const sentenceEndings = [
    "。",
    "！",
    "？",
    ".",
    "!",
    "?",
    "\n\n",
    "\n",
  ];
  
  for (const ending of sentenceEndings) {
    const lastIndex = truncatedText.lastIndexOf(ending);
    if (lastIndex > maxChars * 0.9) {
      // 如果找到的位置在 90% 之后，使用这个位置截断
      truncatedText = truncatedText.slice(0, lastIndex + ending.length);
      break;
    }
  }

  if (addSuffix) {
    const remainingTokens = originalTokens - estimateTokenCount(truncatedText);
    truncatedText += `\n\n[... 文件内容过长，已截断。剩余约 ${Math.ceil(remainingTokens / 1000)}k tokens 未显示 ...]`;
  }

  const finalTokens = estimateTokenCount(truncatedText);

  return {
    text: truncatedText,
    truncated: true,
    originalTokens,
    finalTokens,
  };
}

/**
 * 格式化 token 数量为易读格式
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens} tokens`;
  }
  if (tokens < 10000) {
    return `${(tokens / 1000).toFixed(1)}k tokens`;
  }
  return `${Math.round(tokens / 1000)}k tokens`;
}

/**
 * 检查文本是否会超出指定模型的 context window
 * 
 * @param text 文本内容
 * @param modelId 模型 ID
 * @returns 是否超出限制
 */
export function isWithinContextWindow(
  text: string,
  modelId: string
): { withinLimit: boolean; tokens: number; maxTokens: number } {
  const tokens = estimateTokenCount(text);

  // 不同模型的 context window 限制
  const contextWindowLimits: Record<string, number> = {
    // OpenAI
    "gpt-4": 8192,
    "gpt-4-32k": 32768,
    "gpt-4-turbo": 128000,
    "gpt-4o": 128000,
    "gpt-3.5-turbo": 16384,
    
    // Anthropic
    "claude-3-opus": 200000,
    "claude-3-sonnet": 200000,
    "claude-3-haiku": 200000,
    "claude-3.5-sonnet": 200000,
    
    // Default
    default: 128000,
  };

  // 查找匹配的模型限制
  let maxTokens = contextWindowLimits.default;
  for (const [key, limit] of Object.entries(contextWindowLimits)) {
    if (modelId.includes(key)) {
      maxTokens = limit;
      break;
    }
  }

  // 保留一些余量（80%）
  const effectiveLimit = maxTokens * 0.8;

  return {
    withinLimit: tokens <= effectiveLimit,
    tokens,
    maxTokens: Math.floor(effectiveLimit),
  };
}
