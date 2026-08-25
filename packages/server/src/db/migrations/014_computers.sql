-- Computer 一等公民：每位成员自己的办公室（P0 一人一行）。
-- 设计文档：docs/2026-08-23/02-computer-onboarding-design.md.md
-- 不给 machine_tokens / agents 加 computer_id；连接键仍是 userId。

CREATE TABLE IF NOT EXISTS computers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  server_id UUID NOT NULL REFERENCES servers(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  hostname TEXT,
  os TEXT,
  arch TEXT,
  daemon_version TEXT,
  runtimes JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_computers_server ON computers (server_id);

-- 表若先于 014 手工建过，CREATE TABLE IF NOT EXISTS 是 no-op，补列。
ALTER TABLE computers ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '我的计算机';
ALTER TABLE computers ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE computers ADD COLUMN IF NOT EXISTS hostname TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS os TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS arch TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS daemon_version TEXT;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS runtimes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS last_ready_at TIMESTAMPTZ;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
