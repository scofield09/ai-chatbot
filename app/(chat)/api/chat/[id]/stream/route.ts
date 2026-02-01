import { createUIMessageStream, JsonToSseTransformStream } from "ai";
import { differenceInSeconds } from "date-fns";
import { auth } from "@/app/(auth)/auth";
import {
  getChatById,
  getMessagesByChatId,
  getStreamIdsByChatId,
} from "@/lib/db/queries";
import type { Chat } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { getStreamContext } from "../../route";
import { headers } from "next/headers";

// 消息恢复的时间阈值（秒）
const MESSAGE_RECOVERY_THRESHOLD_SECONDS = 15;

/**
 * 创建空数据流（SSE 格式）
 * 用于在没有可恢复内容时返回
 */
function createEmptyStreamResponse() {
  const emptyDataStream = createUIMessageStream<ChatMessage>({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: "Needs to exist"
    execute: () => {},
  });
  
  return new Response(
    emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
    { 
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    }
  );
}

/**
 * 尝试从数据库恢复最近的 assistant 消息
 * @param chatId 聊天 ID
 * @param resumeRequestedAt 请求恢复的时间
 * @returns Response 对象（SSE 格式）
 */
async function tryRestoreMessageFromDatabase(
  chatId: string,
  resumeRequestedAt: Date
) {
  const messages = await getMessagesByChatId({ id: chatId });
  const mostRecentMessage = messages.at(-1);

  // 如果没有消息或最近的消息不是 assistant 消息，返回空流
  if (!mostRecentMessage || mostRecentMessage.role !== "assistant") {
    console.log('⚠️ 没有可恢复的 assistant 消息');
    return createEmptyStreamResponse();
  }

  const messageCreatedAt = new Date(mostRecentMessage.createdAt);

  // 如果消息创建时间超过阈值，则不恢复（可能是旧消息）
  if (differenceInSeconds(resumeRequestedAt, messageCreatedAt) > MESSAGE_RECOVERY_THRESHOLD_SECONDS) {
    console.log(`⚠️ 消息太旧（>${MESSAGE_RECOVERY_THRESHOLD_SECONDS}秒），不进行恢复`);
    return createEmptyStreamResponse();
  }

  console.log('✅ 从数据库恢复最近的消息');

  // 创建一个恢复流，包含最近的 assistant 消息
  const restoredStream = createUIMessageStream<ChatMessage>({
    execute: ({ writer }) => {
      writer.write({
        type: "data-appendMessage",
        data: JSON.stringify(mostRecentMessage),
        transient: true,
      });
    },
  });

  return new Response(
    restoredStream.pipeThrough(new JsonToSseTransformStream()),
    { 
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    }
  );
}

/**
 * 服务端重新生成回答
 * 当 Redis 中没有流或流已过期时，直接调用 /api/chat 重新生成
 */
async function regenerateResponse(
  chatId: string,
  chat: Chat,
  session: any,
  reason: string
): Promise<Response> {
  console.log(`🔄 [Stream Regenerate] 开始服务端重新生成，原因: ${reason}`);
  
  try {
    // 1. 获取最后的用户消息
    const messages = await getMessagesByChatId({ id: chatId });
    const lastUserMessage = messages
      .slice()
      .reverse()
      .find(m => m.role === "user");
    
    if (!lastUserMessage) {
      console.error('❌ [Stream Regenerate] 找不到用户消息');
      return createEmptyStreamResponse();
    }
    
    console.log('✅ [Stream Regenerate] 找到用户消息，准备重新生成');
    
    // 2. 获取当前请求的 headers
    const headersList = await headers();
    const host = headersList.get('host') || 'localhost:3000';
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;
    
    // 3. 构造请求体
    const requestBody = {
      id: chatId,
      message: {
        id: lastUserMessage.id,
        role: lastUserMessage.role,
        parts: lastUserMessage.parts,
      },
      selectedChatModel: 'gpt-4o-mini',  // 使用默认模型
      selectedVisibilityType: chat.visibility,
    };
    
    console.log('🔄 [Stream Regenerate] 调用 POST /api/chat');
    
    // 4. 调用 /api/chat 重新生成
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': headersList.get('cookie') || '',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      console.error('❌ [Stream Regenerate] 重新生成失败:', response.status);
      return createEmptyStreamResponse();
    }
    
    if (!response.body) {
      console.error('❌ [Stream Regenerate] 响应没有 body');
      return createEmptyStreamResponse();
    }
    
    console.log('✅ [Stream Regenerate] 重新生成成功，返回新流');
    
    // 5. 直接透传响应流
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
    
  } catch (error) {
    console.error('❌ [Stream Regenerate] 重新生成出错:', error);
    console.error('错误详情:', error instanceof Error ? error.stack : error);
    return createEmptyStreamResponse();
  }
}

/**
 * GET /api/chat/[id]/stream
 * 
 * 从 Redis 恢复可恢复流，如果流已过期则从数据库恢复最近的消息
 * 
 * 恢复策略（按优先级）：
 * 1. 从 Redis 恢复流（最快，实时数据）
 * 2. 从数据库恢复最近的 assistant 消息（降级方案）
 * 3. 返回空流（没有可恢复的内容）
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: chatId } = await params;

  console.log('🔄 [Stream Resume] 开始恢复流, chatId:', chatId);
  
  const streamContext = getStreamContext();
  const resumeRequestedAt = new Date();

  // 如果没有配置 Redis 或不支持可恢复流，返回空响应
  if (!streamContext) {
    console.log('⚠️ [Stream Resume] 未配置 REDIS_URL 或不支持可恢复流');
    return new Response(null, { status: 204 });
  }

  if (!chatId) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  // 验证用户身份
  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  // 获取聊天信息并验证权限
  let chat: Chat | null;

  try {
    chat = await getChatById({ id: chatId });
  } catch {
    return new ChatSDKError("not_found:chat").toResponse();
  }

  if (!chat) {
    return new ChatSDKError("not_found:chat").toResponse();
  }

  // 检查访问权限
  if (chat.visibility === "private" && chat.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  // 从数据库获取该聊天的所有流 ID
  const streamIds = await getStreamIdsByChatId({ chatId });

  // 策略 1: 如果没有流 ID，服务端自动重新生成
  if (!streamIds.length) {
    console.log('⚠️ [Stream Resume] 未找到流 ID，服务端自动重新生成');
    return regenerateResponse(chatId, chat, session, 'no_stream_id');
  }

  // 获取最近的流 ID（与 route.ts 中的存储逻辑对应）
  const recentStreamId = streamIds.at(-1);

  if (!recentStreamId) {
    console.log('⚠️ [Stream Resume] 流 ID 无效');
    return createEmptyStreamResponse();
  }

  console.log('✅ [Stream Resume] 找到流 ID:', recentStreamId);

  // 策略 2: 尝试从 Redis 恢复流
  // 关键：检查流的状态，决定是恢复还是继续生成
  let stream: ReadableStream | null = null;
  
  try {
    console.log('🔍 [Stream Resume] 检查流状态...');
    const streamStatus = await streamContext.hasExistingStream(recentStreamId);
    
    if (streamStatus === true) {
      // 流正在进行中 - 直接恢复并继续
      console.log('✅ [Stream Resume] 流正在进行中，恢复并继续接收数据');
      
      stream = await streamContext.resumableStream(
        recentStreamId,
        () => {
          // 这个回调不会被调用，因为流还在进行中
          const emptyStream = createUIMessageStream<ChatMessage>({
            // biome-ignore lint/suspicious/noEmptyBlockStatements: "Needs to exist"
            execute: () => {},
          });
          return emptyStream.pipeThrough(new JsonToSseTransformStream());
        }
      );
    } else if (streamStatus === "DONE") {
      // 流已完成 - 检查是否需要重新生成
      console.log('⚠️ [Stream Resume] 流已完成');
      
      // 尝试从数据库恢复，如果消息太旧或不存在，则重新生成
      const messages = await getMessagesByChatId({ id: chatId });
      const mostRecentMessage = messages.at(-1);
      
      if (!mostRecentMessage || mostRecentMessage.role !== "assistant") {
        console.log('⚠️ [Stream Resume] 没有 assistant 消息，服务端自动重新生成');
        return regenerateResponse(chatId, chat, session, 'no_assistant_message');
      }
      
      const messageCreatedAt = new Date(mostRecentMessage.createdAt);
      const timeDiff = differenceInSeconds(resumeRequestedAt, messageCreatedAt);
      
      if (timeDiff > MESSAGE_RECOVERY_THRESHOLD_SECONDS) {
        console.log(`⚠️ [Stream Resume] 消息太旧（${timeDiff}秒），服务端自动重新生成`);
        return regenerateResponse(chatId, chat, session, 'message_too_old');
      }
      
      // 消息还新鲜，可以恢复
      console.log('✅ [Stream Resume] 从数据库恢复最近的消息');
      return tryRestoreMessageFromDatabase(chatId, resumeRequestedAt);
      
    } else {
      // 流不存在 - 服务端自动重新生成
      console.log('⚠️ [Stream Resume] 流不存在，服务端自动重新生成');
      return regenerateResponse(chatId, chat, session, 'stream_not_found');
    }
    
    if (stream) {
      console.log('✅ [Stream Resume] 成功恢复流');
    } else {
      console.log('⚠️ [Stream Resume] resumableStream 返回 null');
    }
  } catch (error) {
    console.error('❌ [Stream Resume] Redis 恢复流失败:', error);
    console.error('错误详情:', error instanceof Error ? error.stack : error);
    // 继续尝试从数据库恢复
  }

  // 策略 3: 如果流不存在，服务端自动重新生成
  if (!stream) {
    console.log('⚠️ [Stream Resume] 无法恢复流，服务端自动重新生成');
    return regenerateResponse(chatId, chat, session, 'stream_recovery_failed');
  }

  console.log('✅ [Stream Resume] 准备返回流给客户端');
  return new Response(stream, { 
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}
