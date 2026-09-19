-- Server 级计算机模型：computers 从「一人一机一行」改为 (user, server, machine) 三维注册。
-- 设计文档：docs/2026-09-19/01-server-scoped-computers.md
-- - machine_uuid：daemon 首启生成并持久化于本机 .slock/machine-id，ready 帧上报；
--   它是「同一台物理机」的稳定身份（hostname 可变，不做键）。
-- - 存量行回填 legacy-<id> 占位：视为「已在该 server 注册」，下次 daemon ready
--   携带真 uuid 时由 upsert 逻辑回填为真值（同 (user,server) 只有占位行时原地改写）。
-- - agents.computer_id：agent 绑定到具体机器——多机在线后派发按绑定机器路由。

ALTER TABLE computers ADD COLUMN IF NOT EXISTS machine_uuid TEXT;
UPDATE computers SET machine_uuid = 'legacy-' || id::text WHERE machine_uuid IS NULL;
ALTER TABLE computers ALTER COLUMN machine_uuid SET NOT NULL;

ALTER TABLE computers DROP CONSTRAINT IF EXISTS computers_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS computers_user_server_machine_uniq
  ON computers (user_id, server_id, machine_uuid);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS computer_id UUID REFERENCES computers(id);
CREATE INDEX IF NOT EXISTS idx_agents_computer ON agents (computer_id);
