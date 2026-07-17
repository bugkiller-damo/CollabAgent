-- 频道内经理 agent 派发任务给 worker agent 的台账。
-- 和 messages 里那种任何人可认领的任务看板（task_number/task_status）不同：
-- dispatch 是经理对某个 worker 的一对一任务合同，需要严格的归属校验。
CREATE TABLE IF NOT EXISTS dispatches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    from_agent_id UUID NOT NULL REFERENCES agents(id),
    to_agent_id UUID NOT NULL REFERENCES agents(id),
    text TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','reported','cancelled')),
    report_text TEXT,
    artifacts JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reported_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dispatches_to_agent_open ON dispatches (to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_dispatches_channel ON dispatches (channel_id, created_at);

-- 频道是否有经理 agent、谁是经理，由用户自己决定（见 channels.ts 的 PATCH members）。
ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS is_manager BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_members_single_manager
  ON channel_members (channel_id) WHERE is_manager = true;
