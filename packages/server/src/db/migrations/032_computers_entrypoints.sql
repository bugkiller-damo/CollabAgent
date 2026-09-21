-- Phase 4：computers 行持久化 bridge runtime entrypoint 探测摘要
-- （daemon ready 上报的 manifest entrypoints：id/label/runtime/status/
-- 模型名单/能力——无 command/cwd/secret）。离线时序列化走该快照。
ALTER TABLE computers ADD COLUMN IF NOT EXISTS entrypoints JSONB NOT NULL DEFAULT '[]'::jsonb;
