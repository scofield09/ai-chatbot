# RAG (Retrieval-Augmented Generation) 功能说明

## 概述

本项目已集成基于 pgvector 的 RAG 功能，允许用户将文档索引到知识库中，并在对话时检索相关文档作为上下文。

## 功能特性

1. **文档索引** (`indexDocument`): 将文档分块并生成向量嵌入，存储到向量数据库
2. **文档检索** (`retrieveDocuments`): 基于查询语义搜索相关文档片段
3. **知识库管理**: 支持创建多个知识库来组织文档

## 数据库设置

### 1. 安装 pgvector 扩展

确保你的 PostgreSQL 数据库已安装 pgvector 扩展：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. 运行数据库迁移

```bash
pnpm db:migrate
```

这将创建以下表：
- `KnowledgeBase`: 知识库表
- `DocumentEmbedding`: 文档嵌入向量表

## 使用方法

### 1. 索引文档

用户可以通过以下方式索引文档：

```
用户: "请将这个文档添加到知识库"
AI: [使用 indexDocument 工具索引文档]
```

或者直接告诉 AI：
```
用户: "索引文档 [document-id]"
```

### 2. 检索文档

当用户提问时，AI 会自动使用 `retrieveDocuments` 工具搜索相关文档：

```
用户: "我之前添加的文档中提到了什么？"
AI: [使用 retrieveDocuments 搜索] -> [基于检索结果回答]
```

### 3. 创建知识库（可选）

用户可以通过代码创建知识库来组织文档：

```typescript
import { createKnowledgeBase } from "@/lib/db/queries";

const kb = await createKnowledgeBase({
  userId: "user-id",
  name: "技术文档",
  description: "技术相关的文档集合",
});
```

## 技术实现

### 向量维度

- 使用智谱AI `embedding-2` 模型
- 向量维度: 1024（embedding-2）或 2048（embedding-3，如使用）

### 文档分块策略

- 最大块大小: 1000 字符
- 重叠大小: 200 字符
- 在句子边界处分割

### 相似度搜索

- 使用余弦距离 (`<=>` 操作符)
- 默认相似度阈值: 0.7
- 返回最相似的 N 个结果（默认 5 个）

## API 工具

### indexDocument

索引文档到知识库。

**参数:**
- `documentId` (string, UUID): 要索引的文档 ID
- `knowledgeBaseId` (string, UUID, 可选): 知识库 ID

**返回:**
```json
{
  "success": true,
  "chunksIndexed": 10,
  "message": "Successfully indexed 10 chunks from document..."
}
```

### retrieveDocuments

检索相关文档。

**参数:**
- `query` (string): 搜索查询
- `limit` (number, 1-10, 默认 5): 返回结果数量
- `knowledgeBaseId` (string, UUID, 可选): 在指定知识库中搜索

**返回:**
```json
{
  "results": [
    {
      "documentId": "uuid",
      "documentTitle": "文档标题",
      "content": "文档内容片段",
      "similarity": 0.85,
      "chunkIndex": 0
    }
  ],
  "count": 5,
  "query": "搜索查询"
}
```

## 环境变量

确保设置了以下环境变量：

- `POSTGRES_URL`: PostgreSQL 连接字符串（必须支持 pgvector）
- `ZHIPUAI_API_KEY`: 智谱AI API 密钥（用于生成嵌入）

## 注意事项

1. **数据库要求**: PostgreSQL 必须安装 pgvector 扩展
2. **权限**: 用户只能索引和检索自己拥有的文档
3. **性能**: 大量文档时建议创建向量索引以提高查询速度
4. **成本**: 每次索引和检索都会调用 OpenAI API 生成嵌入，注意 API 使用成本

## 创建向量索引（可选，提高性能）

对于大量文档，建议创建向量索引：

```sql
CREATE INDEX IF NOT EXISTS document_embedding_vector_idx 
ON "DocumentEmbedding" 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

## 故障排除

### 错误: "vector type does not exist"

确保已安装 pgvector 扩展：
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 错误: "Failed to index document"

检查：
1. 文档是否存在且有内容
2. 用户是否有权限访问该文档
3. 智谱AI API 密钥是否正确设置

### 检索结果为空

可能原因：
1. 没有索引任何文档
2. 相似度阈值太高（默认 0.7）
3. 查询与文档内容不相关

