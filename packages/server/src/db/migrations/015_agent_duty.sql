-- Agent 值班意愿（与 agents.status 归档正交）。
-- 设计文档：docs/2026-08-23/05-agent-duty-design.md
-- 存量行 DEFAULT 'on'：行为与今天一致（daemon 连上即可被唤醒）。

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS duty varchar(8) NOT NULL DEFAULT 'on';

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_duty_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_duty_check CHECK (duty IN ('on', 'off'));

CREATE INDEX IF NOT EXISTS idx_agents_duty ON agents (user_id, duty);

COMMENT ON COLUMN agents.duty IS 'Desired availability: on = eligible to wake; off = human off-duty';
