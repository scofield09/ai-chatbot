import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
} from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
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
import { retrieveRelevantContext } from "./retrieve-context";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;
export const MAX_MESSAGES = 10;

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

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

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      if (!isToolApprovalFlow) {
        const allMessages = await getMessagesByChatId({ id });
        // messagesFromDb = await getMessagesByChatId({ id });
        // 先按消息数量限制
        let limitedMessages = allMessages.slice(-MAX_MESSAGES);
        messagesFromDb = limitedMessages;
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

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

    // 处理文件附件：从 Redis 获取文件内容并添加到消息上下文
    if (message?.role === "user" && message.parts && !isToolApprovalFlow) {
      // 使用 any 类型来绕过严格的类型检查，因为实际运行时可能包含文档文件
      const fileParts = (message.parts as any[]).filter(
        (part: any) =>
          part.type === "file" && 
          part.fileId && // 只处理有 fileId 的文件（文档类型）
          (part.mediaType === "application/pdf" || 
           part.mediaType === "text/plain" || 
           part.mediaType === "text/markdown")
      );

      if (fileParts.length > 0) {
        console.log(`📎 Processing ${fileParts.length} file attachment(s)`);

        const { getFileContent } = await import("@/lib/redis/file-cache");
        
        for (const filePart of fileParts) {
          const fileName = filePart.name as string;
          const fileId = filePart.fileId as string;

          console.log(`📄 Retrieving file content: ${fileName} (fileId: ${fileId})`);

          try {
            const fileContent = await getFileContent(fileId);

            if (fileContent) {
              console.log(`✅ File content retrieved: ${fileContent.length} characters`);

              // 将文件内容作为用户消息插入到对话中
              const fileContentMessage: ChatMessage = {
                id: generateUUID(),
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: `[附件内容 - ${fileName}]\n\n${fileContent}\n\n[附件结束]`,
                  },
                ],
              };

              // 在当前用户消息之前插入文件内容消息
              const userMessageIndex = uiMessages.findIndex((m) => m.id === message.id);
              if (userMessageIndex !== -1) {
                uiMessages.splice(userMessageIndex, 0, fileContentMessage);
              } else {
                // 如果找不到当前消息，插入到最后
                uiMessages.push(fileContentMessage);
              }

              console.log(`✅ File content added to message context`);
            } else {
              console.log(`⚠️ File content not found in Redis for fileId: ${fileId}`);
              // 通知用户文件内容已过期
              const expiredMessage: ChatMessage = {
                id: generateUUID(),
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: `[提示：文件 "${fileName}" 的内容已过期或无法获取，请重新上传]`,
                  },
                ],
              };
              uiMessages.push(expiredMessage);
            }
          } catch (error) {
            console.error(`❌ Error retrieving file content:`, error);
          }
        }
      }
    }

    // 自动从向量数据库检索相关文档（RAG）
    const { updatedMessages, retrievedDocuments } =
      await retrieveRelevantContext({
        message,
        uiMessages,
        userId: session.user?.id,
        isToolApprovalFlow,
      });

    // 使用包含检索到的文档上下文的消息
    uiMessages = updatedMessages;

    console.log(uiMessages, 'uiMessages------------');
    console.log(JSON.stringify(uiMessages), 'uiMessages------------');

    const isReasoningModel =
      selectedChatModel.includes("reasoning") ||
      selectedChatModel.includes("thinking");

    const modelMessages = await convertToModelMessages(uiMessages);

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
      execute: async ({ writer: dataStream }) => {
        console.log(requestHints, 'requestHints------------')
        const result = streamText({
          model: getLanguageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }),
          messages: modelMessages,
          stopWhen: stepCountIs(5),
          experimental_activeTools: isReasoningModel
            ? []
            : [
                "getWeather",
                // "createDocument",
                // "updateDocument",
                "requestSuggestions",
                // "retrieveDocuments",
                // "indexDocument",
              ],
          providerOptions: isReasoningModel
            ? {
                anthropic: {
                  thinking: { type: "enabled", budgetTokens: 10_000 },
                },
              }
            : undefined,
          tools: {
            getWeather,
            // createDocument: createDocument({ session, dataStream }),
            // updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({ session, dataStream }),
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
        });

        dataStream.merge(result.toUIMessageStream({ sendReasoning: true }));

        if (titlePromise) {
          const title = await titlePromise;
          dataStream.write({ type: "data-chat-title", data: title });
          updateChatTitleById({ chatId: id, title });
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages: finishedMessages }) => {
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
      },
      onError: () => "Oops, an error occurred!",
    });

    return createUIMessageStreamResponse({
      stream,
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
          // ignore redis errors
        }
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

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
