import "server-only";

import type { ChatMessage } from "@/lib/types";
import { getTextFromMessage } from "@/lib/utils";

type QueryRewriterParams = {
  currentQuery: string;
  conversationHistory: ChatMessage[];
  maxHistoryMessages?: number;
};

type QueryRewriterResult = {
  originalQuery: string;
  rewrittenQuery: string;
  success: boolean;
  error?: string;
};

/**
 * 使用智谱AI对用户的查询进行重写和补全
 * 
 * 功能：
 * 1. 结合对话历史上下文理解用户意图
 * 2. 补全简短或模糊的查询
 * 3. 添加相关的上下文信息
 * 4. 扩展关键词以提高RAG检索准确性
 * 
 * 使用场景：
 * - "它是什么？" -> "前面提到的 XXX 是什么？"
 * - "再详细点" -> "请详细解释 XXX 的工作原理"
 * - "还有吗" -> "除了 XXX，还有其他类似的 YYY 吗？"
 */
export async function rewriteQuery({
  currentQuery,
  conversationHistory,
  maxHistoryMessages = 5,
}: QueryRewriterParams): Promise<QueryRewriterResult> {
  console.log("\n=== 🔄 查询重写开始 ===");
  console.log("原始查询:", currentQuery);

  // 如果查询太短（可能需要上下文），或者包含指代词，则进行重写
//   const needsRewriting =
//     currentQuery.length < 15 ||
//     /它|他|她|这个|那个|这里|那里|还有|继续|详细|再说|多说/.test(
//       currentQuery
//     );

//   if (!needsRewriting) {
//     console.log("✅ 查询足够清晰，无需重写");
//     console.log("=== 🔄 查询重写结束 ===\n");
//     return {
//       originalQuery: currentQuery,
//       rewrittenQuery: currentQuery,
//       success: true,
//     };
//   }

  const apiKey = process.env.ZHIPUAI_API_KEY;
  if (!apiKey) {
    console.error("❌ ZHIPUAI_API_KEY 未配置");
    return {
      originalQuery: currentQuery,
      rewrittenQuery: currentQuery,
      success: false,
      error: "ZHIPUAI_API_KEY not configured",
    };
  }

  try {
    // 构建对话历史上下文（最近N条消息）
    const recentHistory = conversationHistory
      .slice(-maxHistoryMessages * 2) // 取最近的N轮对话（用户+助手）
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => {
        const text = getTextFromMessage(msg);
        return {
          role: msg.role,
          content: text || "",
        };
      })
      .filter((msg) => msg.content.trim().length > 0);

    // 构建提示词
    const systemPrompt = `你是一个专业的查询优化助手。你的任务是将用户的简短或模糊查询重写为清晰、完整、易于检索的查询。

**重写规则：**
1. 如果用户使用指代词（它、这个、那个等），替换为具体的实体或概念
2. 如果查询太简短，补充必要的上下文信息
3. 如果查询模糊，明确用户的具体意图
4. 保持查询的核心问题不变
5. 输出纯文本查询，不要添加任何解释或额外内容

**示例：**
- 输入: "它是什么？" + 上下文: "React Hooks..."
  输出: "React Hooks 是什么？"

- 输入: "再详细点" + 上下文: "介绍了向量数据库..."
  输出: "请详细介绍向量数据库的工作原理和应用场景"

- 输入: "还有其他的吗" + 上下文: "推荐了 Next.js..."
  输出: "除了 Next.js，还有哪些类似的全栈 React 框架？"

**重要：只输出重写后的查询文本，不要添加任何其他内容。**`;

    const userPrompt = recentHistory.length > 0
      ? `**对话历史：**
${recentHistory.map((msg, i) => `${i + 1}. [${msg.role}]: ${msg.content}`).join("\n")}

**当前查询：**
${currentQuery}

请根据对话历史，将当前查询重写为清晰、完整的查询。只输出重写后的查询文本。`
      : `**当前查询：**
${currentQuery}

请将这个查询重写为更清晰、更完整的形式。只输出重写后的查询文本。`;

    console.log(`📝 发送重写请求（历史消息数: ${recentHistory.length}）...`);

    // 调用智谱AI API
    const response = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "GLM-4-Flash", // 使用快速模型以降低延迟
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3, // 低温度以保证稳定输出
          max_tokens: 200, // 重写的查询不需要太长
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ 智谱AI API 错误:", response.status, errorText);
      throw new Error(
        `ZhipuAI API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();

    if (
      !data.choices ||
      !Array.isArray(data.choices) ||
      data.choices.length === 0
    ) {
      console.error("❌ 无效的API响应:", data);
      throw new Error("Invalid response from ZhipuAI API");
    }

    const rewrittenQuery = data.choices[0].message.content.trim();

    // 验证重写后的查询
    if (!rewrittenQuery || rewrittenQuery.length === 0) {
      console.warn("⚠️ 重写结果为空，使用原始查询");
      return {
        originalQuery: currentQuery,
        rewrittenQuery: currentQuery,
        success: false,
        error: "Empty rewritten query",
      };
    }

    // 如果重写后的查询太长（可能AI误解了任务），使用原始查询
    if (rewrittenQuery.length > currentQuery.length * 5) {
      console.warn(
        "⚠️ 重写结果过长，可能包含解释，使用原始查询"
      );
      return {
        originalQuery: currentQuery,
        rewrittenQuery: currentQuery,
        success: false,
        error: "Rewritten query too long",
      };
    }

    console.log("✅ 查询重写成功");
    console.log("原始查询:", currentQuery);
    console.log("重写查询:", rewrittenQuery);
    console.log("=== 🔄 查询重写结束 ===\n");

    return {
      originalQuery: currentQuery,
      rewrittenQuery,
      success: true,
    };
  } catch (error) {
    console.error("❌ 查询重写失败:", error);
    if (error instanceof Error) {
      console.error("错误详情:", error.message);
    }
    console.log("=== 🔄 查询重写结束（失败）===\n");

    // 失败时返回原始查询，不影响主流程
    return {
      originalQuery: currentQuery,
      rewrittenQuery: currentQuery,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
