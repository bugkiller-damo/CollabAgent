-- 014 已 apply 但 computers 是旧壳（无 runtimes）时补列。
-- 设计：docs/2026-08-23/02-computer-onboarding-design.md.md
-- 现象：daemon ready → persist computer ready failed: 关系 "computers" 的 "runtimes" 字段不存在

ALTER TABLE computers ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '我的计算机';
ALTER TABLE computers ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE computers ADD COLUMN IF NOT EXISTS hostname TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS os TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS arch TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS daemon_version TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS runtimes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS last_ready_at TIMESTAMPTZ;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_computers_server ON computers (server_id);
