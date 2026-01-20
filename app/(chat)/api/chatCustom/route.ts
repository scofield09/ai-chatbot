import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  smoothStream,
  stepCountIs,
  streamText,
} from "ai";
import { after } from "next/server";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
// import { indexDocument } from "@/lib/ai/tools/index-document";
import { retrieveDocuments } from "@/lib/ai/tools/retrieve-documents";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import { generateEmbedding } from "@/lib/ai/embeddings";
import { searchSimilarDocuments } from "@/lib/db/queries";
import { cleanQueryText } from "@/lib/utils/text-cleaning";
import { getTextFromMessage } from "@/lib/utils";
import type { RetrievedDocument } from "@/lib/ai/prompts";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

const MAX_MESSAGES = 30; // 最多保留 30 条消息
const MAX_TOKENS = 8000; // 最多 8000 tokens

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes("REDIS_URL")) {
        console.log(
          " > Resumable streams are disabled due to missing REDIS_URL"
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError("rate_limit:chat").toResponse();
    }

    // Check if this is a tool approval flow (all messages sent)
    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      // Only fetch messages if chat already exists and not tool approval
      if (!isToolApprovalFlow) {
        const allMessages = await getMessagesByChatId({ id });
        // messagesFromDb = await getMessagesByChatId({ id });
        // 先按消息数量限制
        let limitedMessages = allMessages.slice(-MAX_MESSAGES);
        messagesFromDb = limitedMessages;
      }
    } else if (message?.role === "user") {
      // Save chat immediately with placeholder title
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });

      // Start title generation in parallel (don't await)
      titlePromise = generateTitleFromUserMessage({ message });
    }

    // Use all messages for tool approval, otherwise DB messages + new message
    let uiMessages = isToolApprovalFlow
      ? (messages as ChatMessage[])
      : [...convertToUIMessages(messagesFromDb), message as ChatMessage];

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    // Only save user messages to the database (not tool approval responses)
    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    // Automatically retrieve relevant documents from vector database BEFORE streaming
    // This avoids blocking the stream response and allows parallel processing
    let retrievedDocuments: RetrievedDocument[] = [];
    if (message?.role === "user" && session.user?.id && !isToolApprovalFlow) {
      try {
        const userMessageText = getTextFromMessage(message);
        console.log(userMessageText, 'userMessageText------------')
        if (userMessageText && userMessageText.trim().length > 0) {
          // Clean and generate embedding for the query
          const cleanedQuery = cleanQueryText(userMessageText);
          
          if (cleanedQuery && cleanedQuery.trim().length > 0) {
            const queryEmbedding = await generateEmbedding(cleanedQuery);
            console.log(queryEmbedding, 'queryEmbedding------------')
            // Search for similar documents
            const queryLength = cleanedQuery.length;
            const dynamicThreshold = queryLength < 10 
              ? 0.5  // 短查询使用更低的阈值
              : 0.7; // 长查询使用正常阈值

            const searchResults = await searchSimilarDocuments({
              embedding: queryEmbedding,
              limit: 5, // Retrieve top 5 most relevant documents
              knowledgeBaseId: undefined,
              similarityThreshold: dynamicThreshold,
              userId: session.user.id,
            });

            console.log(searchResults, 'searchResults------------')

            retrievedDocuments = searchResults.map((result) => ({
              documentId: result.documentId,
              documentTitle: result.documentTitle,
              content: result.content,
              similarity: result.similarity,
              chunkIndex: result.chunkIndex,
            }));

            console.log(retrievedDocuments, 'retrievedDocuments------------')

            if (retrievedDocuments.length > 0) {
              console.log(
                `Retrieved ${retrievedDocuments.length} relevant documents for query`
              );
              
              // Filter and sort documents by similarity (only include high-quality matches)
              const highQualityDocs = retrievedDocuments
                .filter((doc) => doc.similarity >= 0.6)
                .sort((a, b) => b.similarity - a.similarity);

              if (highQualityDocs.length > 0) {
                // Format retrieved documents as a message and add to uiMessages
                // Use compact format to save tokens while maintaining clarity
                const documentsText = highQualityDocs
                  .map(
                    (doc, index) => `📄 **${doc.documentTitle}** (${(doc.similarity * 100).toFixed(0)}% relevant)
${doc.content}`
                  )
                  .join("\n\n---\n\n");

                const documentsMessage: ChatMessage = {
                  id: generateUUID(),
                  role: "user",
                  parts: [
                    {
                      type: "text",
                      text: `**Knowledge Base Context** (${highQualityDocs.length} relevant document${highQualityDocs.length > 1 ? 's' : ''}):

${documentsText}

*Use information from these documents to answer the user's question. Cite the document title when referencing specific information.*`,
                    },
                  ],
                };

                // Insert documents message before the user's current message
                // uiMessages = [
                //   ...uiMessages.slice(0, -1),
                //   documentsMessage,
                //   uiMessages[uiMessages.length - 1],
                // ];
              }
            }
          }
        }
      } catch (error) {
        // Log error but don't fail the request - continue without retrieved documents
        console.error("Error retrieving documents:", error);
      }
    }
    console.log(JSON.stringify(uiMessages), 'uiMessages------------');

    console.log(uiMessages, 'uiMessages------------no json');

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    // 自定义流式渲染实现
    const encoder = new TextEncoder();
    let currentMessageId: string | null = null;
    let currentText = "";
    const finishedMessages: ChatMessage[] = [];

    // 创建自定义的 ReadableStream
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // 处理标题生成
          if (titlePromise) {
            titlePromise.then((title) => {
              updateChatTitleById({ chatId: id, title });
              const data = JSON.stringify({
                type: "data-chat-title",
                data: title,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            });
          }

          const isReasoningModel =
            selectedChatModel.includes("reasoning") ||
            selectedChatModel.includes("thinking");

          const result = streamText({
            model: getLanguageModel(selectedChatModel),
            system: systemPrompt({
              selectedChatModel,
              requestHints,
            }),
            messages: await convertToModelMessages(uiMessages),
            stopWhen: stepCountIs(5),
            experimental_activeTools: isReasoningModel
              ? []
              : [
                  "getWeather",
                  "createDocument",
                  "updateDocument",
                  "requestSuggestions",
                ],
            experimental_transform: isReasoningModel
              ? undefined
              : smoothStream({ chunking: "word" }),
            providerOptions: isReasoningModel
              ? {
                  anthropic: {
                    thinking: { type: "enabled", budgetTokens: 10_000 },
                  },
                }
              : undefined,
            tools: {
              getWeather,
              createDocument: createDocument({
                session,
                dataStream: {
                  write: (part: any) => {
                    const data = JSON.stringify(part);
                    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                  },
                } as any,
              }),
              updateDocument: updateDocument({
                session,
                dataStream: {
                  write: (part: any) => {
                    const data = JSON.stringify(part);
                    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                  },
                } as any,
              }),
              requestSuggestions: requestSuggestions({
                session,
                dataStream: {
                  write: (part: any) => {
                    const data = JSON.stringify(part);
                    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                  },
                } as any,
              }),
            },
            experimental_telemetry: {
              isEnabled: isProductionEnvironment,
              functionId: "stream-text",
            },
          });

          // 手动处理流数据
          let reasoningText = "";
          let isReasoningActive = false;

          for await (const delta of result.fullStream) {
            const { type } = delta;

            if (type === "text-delta") {
              const { text } = delta as { type: "text-delta"; text: string };
              currentText += text;

              // 如果是第一条文本增量，创建新消息
              if (!currentMessageId) {
                currentMessageId = generateUUID();
                console.log('[DEBUG] Created new message ID:', currentMessageId);
              }

              // 构建消息，包含推理和文本
              const parts: ChatMessage["parts"] = [];
              
              if (reasoningText) {
                parts.push({
                  type: "reasoning",
                  text: reasoningText,
                } as any);
              }

              if (currentText) {
                parts.push({ type: "text", text: currentText });
              }

              const message: ChatMessage = {
                id: currentMessageId,
                role: "assistant",
                parts,
              };

              const data = JSON.stringify({
                type: "data-appendMessage",
                data: JSON.stringify(message),
                transient: true,
              });
              console.log('[DEBUG] Sending transient message, text length:', currentText.length);
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } else if (type === "reasoning-start") {
              isReasoningActive = true;
              reasoningText = "";
            } else if (type === "reasoning-delta") {
              const reasoningDelta = delta as {
                type: "reasoning-delta";
                text: string;
              };
              reasoningText += reasoningDelta.text;

              if (!currentMessageId) {
                currentMessageId = generateUUID();
              }

              const parts: ChatMessage["parts"] = [];
              
              if (reasoningText) {
                parts.push({
                  type: "reasoning",
                  text: reasoningText,
                } as any);
              }

              if (currentText) {
                parts.push({ type: "text", text: currentText });
              }

              const message: ChatMessage = {
                id: currentMessageId,
                role: "assistant",
                parts,
              };

              const data = JSON.stringify({
                type: "data-appendMessage",
                data: JSON.stringify(message),
                transient: true,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } else if (type === "reasoning-end") {
              isReasoningActive = false;
            } else if (type === "tool-call") {
              const toolCall = delta as any;
              const { toolCallId, toolName, input } = toolCall;

              if (!currentMessageId) {
                currentMessageId = generateUUID();
              }

              // 查找或创建消息
              let message = finishedMessages.find((m) => m.id === currentMessageId);
              if (!message) {
                const parts: ChatMessage["parts"] = [];
                
                if (reasoningText) {
                  parts.push({
                    type: "reasoning",
                    text: reasoningText,
                  } as any);
                }

                if (currentText) {
                  parts.push({ type: "text", text: currentText });
                }

                message = {
                  id: currentMessageId,
                  role: "assistant",
                  parts,
                };
                finishedMessages.push(message);
              }

              // 添加工具调用部分 - 使用正确的工具类型格式
              const toolPartType = `tool-${toolName}` as any;
              const toolPart = {
                type: toolPartType,
                toolCallId,
                input,
                state: "partial-call",
              };

              // 移除旧的工具调用部分（如果有）
              message.parts = message.parts.filter(
                (p) => !(p.type === toolPartType && (p as any).toolCallId === toolCallId)
              );
              message.parts.push(toolPart as any);

              const data = JSON.stringify({
                type: "data-appendMessage",
                data: JSON.stringify(message),
                transient: true,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } else if (type === "tool-result") {
              const toolResult = delta as any;
              const { toolCallId, toolName, result } = toolResult;

              let message = finishedMessages.find((m) => m.id === currentMessageId);
              if (!message && currentMessageId) {
                const parts: ChatMessage["parts"] = [];
                
                if (reasoningText) {
                  parts.push({
                    type: "reasoning",
                    text: reasoningText,
                  } as any);
                }

                if (currentText) {
                  parts.push({ type: "text", text: currentText });
                }

                message = {
                  id: currentMessageId,
                  role: "assistant",
                  parts,
                };
                finishedMessages.push(message);
              }

              if (message) {
                const toolPartType = `tool-${toolName}` as any;
                // 更新工具调用为完成状态
                const toolPartIndex = message.parts.findIndex(
                  (p) => p.type === toolPartType && (p as any).toolCallId === toolCallId
                );

                if (toolPartIndex !== -1) {
                  const toolPart = message.parts[toolPartIndex] as any;
                  toolPart.state = "result";
                  toolPart.output = result;
                } else {
                  // 如果找不到，添加新的工具结果部分
                  message.parts.push({
                    type: toolPartType,
                    toolCallId,
                    output: result,
                  } as any);
                }

                const data = JSON.stringify({
                  type: "data-appendMessage",
                  data: JSON.stringify(message),
                  transient: true,
                });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              }
            }
          }

          // 流结束，保存最终消息
          if (currentMessageId) {
            let finalMessage = finishedMessages.find(
              (m) => m.id === currentMessageId
            );

            if (!finalMessage) {
              const parts: ChatMessage["parts"] = [];
              
              if (reasoningText) {
                parts.push({
                  type: "reasoning",
                  text: reasoningText,
                } as any);
              }

              if (currentText) {
                parts.push({ type: "text", text: currentText });
              }

              finalMessage = {
                id: currentMessageId,
                role: "assistant",
                parts: parts.length > 0 ? parts : [],
              };
              finishedMessages.push(finalMessage);
            } else {
              // 确保最终消息包含所有内容
              const parts: ChatMessage["parts"] = [];
              
              // 先添加推理部分（如果有且还没有）
              if (reasoningText && !finalMessage.parts.some((p) => p.type === "reasoning")) {
                parts.push({
                  type: "reasoning",
                  text: reasoningText,
                } as any);
              } else if (reasoningText) {
                // 如果已有推理部分，更新它
                const reasoningIndex = finalMessage.parts.findIndex((p) => p.type === "reasoning");
                if (reasoningIndex !== -1) {
                  (finalMessage.parts[reasoningIndex] as any).text = reasoningText;
                }
              }

              // 添加文本部分（如果有且还没有）
              if (currentText && !finalMessage.parts.some((p) => p.type === "text")) {
                parts.push({ type: "text", text: currentText });
              } else if (currentText) {
                // 如果已有文本部分，更新它
                const textIndex = finalMessage.parts.findIndex((p) => p.type === "text");
                if (textIndex !== -1) {
                  (finalMessage.parts[textIndex] as any).text = currentText;
                }
              }

              // 保留已有的工具调用部分和其他部分
              const existingParts = finalMessage.parts.filter(
                (p) => p.type !== "reasoning" && p.type !== "text"
              );
              
              // 重新构建 parts：推理 -> 文本 -> 工具调用和其他
              const reasoningParts = finalMessage.parts.filter((p) => p.type === "reasoning");
              const textParts = finalMessage.parts.filter((p) => p.type === "text");
              finalMessage.parts = [...reasoningParts, ...textParts, ...existingParts];
            }

            // 发送最终消息更新，确保 useChat 接收到完整的消息（不使用 transient）
            console.log('[DEBUG] Sending FINAL message:', {
              messageId: finalMessage.id,
              role: finalMessage.role,
              partsCount: finalMessage.parts.length,
              partsTypes: finalMessage.parts.map(p => p.type)
            });
            const finalData = JSON.stringify({
              type: "data-appendMessage",
              data: JSON.stringify(finalMessage),
            });
            console.log('[DEBUG] Final data string length:', finalData.length);
            controller.enqueue(encoder.encode(`data: ${finalData}\n\n`));

            // 保存消息到数据库
            if (isToolApprovalFlow) {
              for (const finishedMsg of finishedMessages) {
                const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
                if (existingMsg) {
                  await updateMessage({
                    id: finishedMsg.id,
                    parts: finishedMsg.parts,
                  });
                } else {
                  await saveMessages({
                    messages: [
                      {
                        id: finishedMsg.id,
                        role: finishedMsg.role,
                        parts: finishedMsg.parts,
                        createdAt: new Date(),
                        attachments: [],
                        chatId: id,
                      },
                    ],
                  });
                }
              }
            } else if (finishedMessages.length > 0) {
              await saveMessages({
                messages: finishedMessages.map((currentMessage) => ({
                  id: currentMessage.id,
                  role: currentMessage.role,
                  parts: currentMessage.parts,
                  createdAt: new Date(),
                  attachments: [],
                  chatId: id,
                })),
              });
            }
          }

          controller.close();
        } catch (error) {
          console.error("Stream error:", error);
          const errorData = JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Oops, an error occurred!",
          });
          controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
          controller.close();
        }
      },
    });

    // 转换为 SSE 格式
    const sseStream = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      try {
        const resumableStream = await streamContext.resumableStream(
          streamId,
          () => stream.pipeThrough(sseStream)
        );
        if (resumableStream) {
          return new Response(resumableStream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }
      } catch (error) {
        console.error("Failed to create resumable stream:", error);
      }
    }

    return new Response(stream.pipeThrough(sseStream), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    // Check for Vercel AI Gateway credit card error
    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatSDKError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatSDKError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
