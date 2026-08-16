-- 事件日志 / 审计（O2）：不可变事件流水 + SHA-256 哈希链。
--
-- 设计要点：
-- - id 用 BIGINT IDENTITY 作为链顺序（哈希链需要单调无歧义的全局顺序，UUID 无序不适用）；
-- - 所有引用字段（actor_id / object_id）不加外键：审计日志必须能「存活于」被审计对象之后，
--   否则删除一条消息会级联删掉它自己的删除事件，失去审计意义；
-- - prev_hash 指向前一条事件的 hash，首条为 NULL；hash = sha256(规范化字段 + prev_hash)，
--   任何一条被篡改都会使后续所有 hash 校验失败（tamper-evident）。
CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_type VARCHAR(10) NOT NULL,
  verb VARCHAR(50) NOT NULL,
  object_type VARCHAR(40) NOT NULL,
  object_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_object ON events (object_type, object_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events (actor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_verb ON events (verb, id DESC);
