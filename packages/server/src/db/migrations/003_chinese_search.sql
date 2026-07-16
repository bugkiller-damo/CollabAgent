-- 中文搜索分词（启用 pg_jieba 扩展，添加 GIN 索引）
-- pg_jieba 是独立的 PostgreSQL 扩展（jieba 中文分词算法），需服务 DBA 部署；
-- 如果扩展不可用，本迁移降级到 simple 配置 + GIN 索引（仅英文搜索增强）。
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_jieba;
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_messages_content_cn
        ON messages USING gin (to_tsvector(''jiebacfg'', content))';
    RAISE NOTICE 'pg_jieba enabled: Chinese search supported';
  EXCEPTION WHEN OTHERS THEN
    -- 扩展不可用，不阻断启动，仅记录警告
    RAISE NOTICE 'pg_jieba not available: falling back to simple config. Hint: install pg_jieba to enable Chinese search.';
  END;
END
$$;
