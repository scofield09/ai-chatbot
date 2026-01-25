/**
 * 查询重写功能使用示例
 * 
 * 这个文件展示了如何使用 query-rewriter 来优化用户查询
 * 注意：这只是一个示例文件，不会在生产环境中运行
 */

import type { ChatMessage } from "@/lib/types";
import { rewriteQuery } from "./query-rewriter";

// 示例 1: 指代词消解
async function example1() {
  const conversationHistory: ChatMessage[] = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "React Hooks 是什么？" }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "React Hooks 是 React 16.8 引入的新特性，允许你在函数组件中使用状态和其他 React 特性...",
        },
      ],
    },
  ];

  const result = await rewriteQuery({
    currentQuery: "它有哪些优点？",
    conversationHistory,
    maxHistoryMessages: 5,
  });

  console.log("示例 1: 指代词消解");
  console.log("原始查询:", result.originalQuery);
  console.log("重写查询:", result.rewrittenQuery);
  console.log("成功:", result.success);
  // 预期输出: "React Hooks 有哪些优点？"
}

// 示例 2: 简短查询补全
async function example2() {
  const conversationHistory: ChatMessage[] = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "介绍一下向量数据库" }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "向量数据库是专门用于存储和检索高维向量的数据库系统...",
        },
      ],
    },
  ];

  const result = await rewriteQuery({
    currentQuery: "再详细点",
    conversationHistory,
    maxHistoryMessages: 5,
  });

  console.log("\n示例 2: 简短查询补全");
  console.log("原始查询:", result.originalQuery);
  console.log("重写查询:", result.rewrittenQuery);
  console.log("成功:", result.success);
  // 预期输出: "请详细介绍向量数据库的工作原理、应用场景和主要特性"
}

// 示例 3: 上下文补充
async function example3() {
  const conversationHistory: ChatMessage[] = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "Next.js 和 React 的区别" }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Next.js 是基于 React 的全栈框架，提供了服务端渲染、静态生成等功能...",
        },
      ],
    },
  ];

  const result = await rewriteQuery({
    currentQuery: "还有其他类似的吗",
    conversationHistory,
    maxHistoryMessages: 5,
  });

  console.log("\n示例 3: 上下文补充");
  console.log("原始查询:", result.originalQuery);
  console.log("重写查询:", result.rewrittenQuery);
  console.log("成功:", result.success);
  // 预期输出: "除了 Next.js，还有哪些类似的基于 React 的全栈框架？"
}

// 示例 4: 清晰查询不需要重写
async function example4() {
  const conversationHistory: ChatMessage[] = [];

  const result = await rewriteQuery({
    currentQuery: "如何在 TypeScript 中使用 React Hooks？",
    conversationHistory,
    maxHistoryMessages: 5,
  });

  console.log("\n示例 4: 清晰查询不需要重写");
  console.log("原始查询:", result.originalQuery);
  console.log("重写查询:", result.rewrittenQuery);
  console.log("成功:", result.success);
  // 预期输出: 原始查询和重写查询相同
}

// 运行所有示例
async function runExamples() {
  console.log("=== 查询重写功能示例 ===\n");

  await example1();
  await example2();
  await example3();
  await example4();

  console.log("\n=== 示例运行完成 ===");
}

// 注意: 这个文件只是示例，不会自动运行
// 如果要测试，可以在开发环境中手动调用 runExamples()
export { example1, example2, example3, example4, runExamples };
