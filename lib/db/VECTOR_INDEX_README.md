# 向量索引迁移说明

## 概述

此迁移为 `DocumentEmbedding` 表添加了向量索引和其他性能优化索引，以提升向量相似度搜索的查询性能。

## 包含的索引

### 1. 向量索引（IVFFlat）
- **索引名**: `document_embedding_vector_idx`
- **类型**: IVFFlat
- **用途**: 加速向量相似度搜索（余弦距离）
- **适用场景**: 数据量 < 100万向量
- **参数**: `lists = 100`（可根据数据量调整）

### 2. 元数据索引
- `document_embedding_document_id_idx`: 文档ID索引
- `document_embedding_knowledge_base_id_idx`: 知识库ID索引
- `document_embedding_doc_kb_idx`: 复合索引（documentId + knowledgeBaseId）
- `document_embedding_created_at_idx`: 创建时间索引

## 使用方法

### 方法1: 使用 Drizzle 迁移（推荐）

```bash
# 运行迁移
pnpm db:migrate
```

### 方法2: 手动执行 SQL

```bash
# 直接执行 SQL 文件
psql $POSTGRES_URL -f lib/db/migrate-vector-indexes.sql
```

或者在数据库客户端中执行 `lib/db/migrate-vector-indexes.sql` 文件的内容。

## 索引选择建议

### IVFFlat vs HNSW

**IVFFlat（当前使用）**:
- ✅ 适合中等规模数据（< 100万向量）
- ✅ 占用存储空间较小
- ✅ 构建速度快
- ⚠️ 查询速度中等

**HNSW（可选）**:
- ✅ 查询速度更快
- ✅ 适合大规模数据（> 100万向量）
- ⚠️ 占用存储空间更大
- ⚠️ 构建时间较长

### 如何切换到 HNSW

如果需要使用 HNSW 索引，可以：

1. 删除 IVFFlat 索引：
```sql
DROP INDEX IF EXISTS document_embedding_vector_idx;
```

2. 创建 HNSW 索引：
```sql
CREATE INDEX IF NOT EXISTS document_embedding_vector_hnsw_idx 
ON "DocumentEmbedding" 
USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

## 性能优化建议

### 调整 IVFFlat 的 lists 参数

`lists` 参数应该设置为 `rows / 1000`（最小值为 10）：

```sql
-- 查看当前数据量
SELECT COUNT(*) FROM "DocumentEmbedding";

-- 根据数据量调整 lists
-- 例如：如果有 50,000 条记录，lists = 50
DROP INDEX IF EXISTS document_embedding_vector_idx;
CREATE INDEX document_embedding_vector_idx 
ON "DocumentEmbedding" 
USING ivfflat ((embedding::vector(1024)) vector_cosine_ops)
WITH (lists = 50);
```

### 索引维护

向量索引在数据更新后可能需要重建：

```sql
-- 重建索引（如果性能下降）
REINDEX INDEX document_embedding_vector_idx;
```

## 验证索引

检查索引是否创建成功：

```sql
-- 查看所有索引
SELECT 
    indexname, 
    indexdef 
FROM pg_indexes 
WHERE tablename = 'DocumentEmbedding'
ORDER BY indexname;

-- 查看索引大小
SELECT 
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE tablename = 'DocumentEmbedding'
ORDER BY pg_relation_size(indexrelid) DESC;
```

## 性能测试

创建索引后，可以测试查询性能：

```sql
-- 测试查询性能（替换为实际的 embedding 向量）
EXPLAIN ANALYZE
SELECT 
    id,
    "documentId",
    content,
    1 - (embedding::vector <=> '[0.1,0.2,...]'::vector(1024)) AS similarity
FROM "DocumentEmbedding"
WHERE 1 - (embedding::vector <=> '[0.1,0.2,...]'::vector(1024)) > 0.7
ORDER BY embedding::vector <=> '[0.1,0.2,...]'::vector(1024)
LIMIT 5;
```

## 注意事项

1. **索引构建时间**: 首次创建索引可能需要一些时间，取决于数据量
2. **存储空间**: 索引会占用额外的存储空间（通常为数据的 20-50%）
3. **写入性能**: 索引会略微降低写入性能，但大幅提升查询性能
4. **数据更新**: 如果数据量大幅增加，可能需要重建索引并调整参数

## 故障排除

### 索引创建失败

如果遇到错误，检查：

1. pgvector 扩展是否已安装：
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

2. embedding 列的类型是否正确：
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'DocumentEmbedding' AND column_name = 'embedding';
```

3. 是否有足够的数据（IVFFlat 需要至少一些数据才能创建索引）

### 查询性能没有提升

1. 确认索引正在使用：
```sql
EXPLAIN ANALYZE <your_query>;
```

2. 检查是否需要更新统计信息：
```sql
ANALYZE "DocumentEmbedding";
```

3. 考虑调整 `lists` 参数或切换到 HNSW
