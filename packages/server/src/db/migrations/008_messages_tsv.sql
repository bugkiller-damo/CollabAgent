-- 消息全文搜索性能：003 迁移建了 jieba 表达式索引，但 /api/messages/search 实际用
-- 'simple' 配置现算 tsvector，索引用不上，消息量增长后搜索退化为全表扫描。
-- 改为 stored 生成列 + GIN 索引，查询直接命中列。
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_content_tsv ON messages USING gin (content_tsv);
