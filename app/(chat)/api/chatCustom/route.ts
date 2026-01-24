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
//     let retrievedDocuments: RetrievedDocument[] = [];
//     if (message?.role === "user" && session.user?.id && !isToolApprovalFlow) {
//       try {
//         const userMessageText = getTextFromMessage(message);
//         console.log(userMessageText, 'userMessageText------------')
//         if (userMessageText && userMessageText.trim().length > 0) {
//           // Clean and generate embedding for the query
//           const cleanedQuery = cleanQueryText(userMessageText);
          
//           if (cleanedQuery && cleanedQuery.trim().length > 0) {
//             const queryEmbedding = await generateEmbedding(cleanedQuery);
//             console.log(queryEmbedding, 'queryEmbedding------------')
//             // Search for similar documents
//             const queryLength = cleanedQuery.length;
//             const dynamicThreshold = queryLength < 10 
//               ? 0.5  // 短查询使用更低的阈值
//               : 0.7; // 长查询使用正常阈值

//             const searchResults = await searchSimilarDocuments({
//               embedding: queryEmbedding,
//               limit: 5, // Retrieve top 5 most relevant documents
//               knowledgeBaseId: undefined,
//               similarityThreshold: dynamicThreshold,
//               userId: session.user.id,
//             });

//             console.log(searchResults, 'searchResults------------')

//             retrievedDocuments = searchResults.map((result) => ({
//               documentId: result.documentId,
//               documentTitle: result.documentTitle,
//               content: result.content,
//               similarity: result.similarity,
//               chunkIndex: result.chunkIndex,
//             }));

//             console.log(retrievedDocuments, 'retrievedDocuments------------')

//             if (retrievedDocuments.length > 0) {
//               console.log(
//                 `Retrieved ${retrievedDocuments.length} relevant documents for query`
//               );
              
//               // Filter and sort documents by similarity (only include high-quality matches)
//               const highQualityDocs = retrievedDocuments
//                 .filter((doc) => doc.similarity >= 0.6)
//                 .sort((a, b) => b.similarity - a.similarity);

//               if (highQualityDocs.length > 0) {
//                 // Format retrieved documents as a message and add to uiMessages
//                 // Use compact format to save tokens while maintaining clarity
//                 const documentsText = highQualityDocs
//                   .map(
//                     (doc, index) => `📄 **${doc.documentTitle}** (${(doc.similarity * 100).toFixed(0)}% relevant)
// ${doc.content}`
//                   )
//                   .join("\n\n---\n\n");

//                 const documentsMessage: ChatMessage = {
//                   id: generateUUID(),
//                   role: "user",
//                   parts: [
//                     {
//                       type: "text",
//                       text: `**Knowledge Base Context** (${highQualityDocs.length} relevant document${highQualityDocs.length > 1 ? 's' : ''}):

// ${documentsText}

// *Use information from these documents to answer the user's question. Cite the document title when referencing specific information.*`,
//                     },
//                   ],
//                 };

//                 // Insert documents message before the user's current message
//                 // uiMessages = [
//                 //   ...uiMessages.slice(0, -1),
//                 //   documentsMessage,
//                 //   uiMessages[uiMessages.length - 1],
//                 // ];
//               }
//             }
//           }
//         }
//       } catch (error) {
//         // Log error but don't fail the request - continue without retrieved documents
//         console.error("Error retrieving documents:", error);
//       }
//     }
    console.log(JSON.stringify(uiMessages), 'uiMessages------------');

    console.log(uiMessages, 'uiMessages------------no json');

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    // 如果需要生成标题，在流开始前就完成
    // 这样标题总是第一个发送的事件，避免与消息流混淆
    let generatedTitle: string | null = null;
    if (titlePromise) {
      try {
        generatedTitle = await titlePromise;
        await updateChatTitleById({ chatId: id, title: generatedTitle });
      } catch (error) {
        console.error("Failed to generate title:", error);
      }
    }

    // 自定义流式渲染实现
    const encoder = new TextEncoder();
    let currentMessageId: string | null = null;
    let currentText = "";
    const finishedMessages: ChatMessage[] = [];

    // 创建自定义的 ReadableStream
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // 如果标题已生成，立即发送作为第一个事件
        //   if (generatedTitle) {
        //     const data = JSON.stringify({
        //       type: "data-chat-title",
        //       data: generatedTitle,
        //     });
        //     controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        //   }

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
            experimental_telemetry: {
              isEnabled: isProductionEnvironment,
              functionId: "stream-text",
            },
          });

          // 手动处理流数据 - 发送完整消息更新
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

              // 发送完整消息（带 transient 标志）用于实时显示
              const parts: ChatMessage["parts"] = [];
              if (reasoningText) {
                parts.push({ type: "reasoning", text: reasoningText } as any);
              }
              parts.push({ type: "text", text: currentText });

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
            } else if (type === "reasoning-start") {
              isReasoningActive = true;
              reasoningText = "";
              
              if (!currentMessageId) {
                currentMessageId = generateUUID();
              }
            } else if (type === "reasoning-delta") {
              const reasoningDelta = delta as {
                type: "reasoning-delta";
                text: string;
              };
              reasoningText += reasoningDelta.text;

              if (!currentMessageId) {
                currentMessageId = generateUUID();
              }
            } else if (type === "reasoning-end") {
              isReasoningActive = false;
            }
          }

          // 流结束，发送最终消息并保存到数据库
          if (currentMessageId && currentText) {
            const parts: ChatMessage["parts"] = [];
            
            if (reasoningText) {
              parts.push({
                type: "reasoning",
                text: reasoningText,
              } as any);
            }

            parts.push({ type: "text", text: currentText });

            const finalMessage: ChatMessage = {
              id: currentMessageId,
              role: "assistant",
              parts,
            };
            
            console.log('[DEBUG] Sending final message (non-transient):', {
              messageId: finalMessage.id,
              textLength: currentText.length,
            });

            // 发送最终消息（不带 transient）用于持久化
            const finalData = JSON.stringify({
              type: "data-appendMessage",
              data: JSON.stringify(finalMessage),
            });
            controller.enqueue(encoder.encode(`data: ${finalData}\n\n`));

            // 保存到数据库
            await saveMessages({
              messages: [{
                id: finalMessage.id,
                role: finalMessage.role,
                parts: finalMessage.parts,
                createdAt: new Date(),
                attachments: [],
                chatId: id,
              }],
            });
            
            console.log('[DEBUG] Message saved to DB successfully');
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
