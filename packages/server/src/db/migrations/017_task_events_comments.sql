-- 任务操作历史 + 任务批注（看板任务详情抽屉的数据源）。
-- 任务 = messages 表的特殊行（task_number 非空），两张表都以 message_id 关联，
-- ON DELETE CASCADE：消息删除时历史/批注一并清理。
CREATE TABLE IF NOT EXISTS task_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL,
    task_number INTEGER NOT NULL,
    actor_id UUID,
    actor_name VARCHAR(120),
    action VARCHAR(24) NOT NULL CHECK (action IN ('created','claimed','unclaimed','status_changed')),
    from_status VARCHAR(20),
    to_status VARCHAR(20),
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_events_message ON task_events (message_id, created_at);

CREATE TABLE IF NOT EXISTS task_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    author_id UUID NOT NULL,
    author_name VARCHAR(120),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_message ON task_comments (message_id, created_at);
