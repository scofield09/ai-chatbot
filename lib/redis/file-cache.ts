import "server-only";

import { createClient } from "redis";

let redisClient: ReturnType<typeof createClient> | null = null;

/**
 * 获取 Redis 客户端实例
 */
async function getRedisClient() {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL environment variable is not set");
  }

  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL,
    });

    redisClient.on("error", (error) => {
      console.error("Redis Client Error:", error);
    });

    await redisClient.connect();
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  return redisClient;
}

/**
 * 存储文件内容到 Redis
 * @param fileId 文件唯一标识
 * @param content 文件文本内容
 * @param ttl 过期时间（秒），默认 3600 秒（1 小时）
 */
export async function setFileContent(
  fileId: string,
  content: string,
  ttl = 3600
): Promise<void> {
  try {
    const client = await getRedisClient();
    const key = `file_content:${fileId}`;
    
    // 使用 SETEX 命令设置键值和过期时间
    await client.setEx(key, ttl, content);
    
    console.log(`✅ File content cached in Redis: ${key} (TTL: ${ttl}s)`);
  } catch (error) {
    console.error("Failed to set file content in Redis:", error);
    throw new Error("Failed to cache file content");
  }
}

/**
 * 从 Redis 获取文件内容
 * @param fileId 文件唯一标识
 * @returns 文件内容，如果不存在或已过期则返回 null
 */
export async function getFileContent(fileId: string): Promise<string | null> {
  try {
    const client = await getRedisClient();
    const key = `file_content:${fileId}`;
    
    const content = await client.get(key);
    
    if (content) {
      console.log(`✅ File content retrieved from Redis: ${key}`);
    } else {
      console.log(`⚠️ File content not found or expired: ${key}`);
    }
    
    return content;
  } catch (error) {
    console.error("Failed to get file content from Redis:", error);
    // 返回 null 而不是抛出错误，让调用者处理
    return null;
  }
}

/**
 * 从 Redis 删除文件内容
 * @param fileId 文件唯一标识
 */
export async function deleteFileContent(fileId: string): Promise<void> {
  try {
    const client = await getRedisClient();
    const key = `file_content:${fileId}`;
    
    await client.del(key);
    
    console.log(`✅ File content deleted from Redis: ${key}`);
  } catch (error) {
    console.error("Failed to delete file content from Redis:", error);
    throw new Error("Failed to delete file content");
  }
}

/**
 * 检查文件内容是否存在于 Redis
 * @param fileId 文件唯一标识
 * @returns 是否存在
 */
export async function hasFileContent(fileId: string): Promise<boolean> {
  try {
    const client = await getRedisClient();
    const key = `file_content:${fileId}`;
    
    const exists = await client.exists(key);
    
    return exists === 1;
  } catch (error) {
    console.error("Failed to check file content existence in Redis:", error);
    return false;
  }
}

/**
 * 延长文件内容的过期时间
 * @param fileId 文件唯一标识
 * @param ttl 新的过期时间（秒）
 */
export async function extendFileContentTTL(
  fileId: string,
  ttl = 3600
): Promise<void> {
  try {
    const client = await getRedisClient();
    const key = `file_content:${fileId}`;
    
    await client.expire(key, ttl);
    
    console.log(`✅ File content TTL extended: ${key} (TTL: ${ttl}s)`);
  } catch (error) {
    console.error("Failed to extend file content TTL in Redis:", error);
    throw new Error("Failed to extend file content TTL");
  }
}
