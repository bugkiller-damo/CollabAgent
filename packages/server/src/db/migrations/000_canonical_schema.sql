-- ============================================================================
-- CollabAgent 权威 schema（单一来源）
-- 全程幂等：CREATE TABLE IF NOT EXISTS（内联 PK/FK/CHECK/UNIQUE，仅新建时生效，
-- 对已存在的表是 no-op，不会因约束已存在而报错）+ ALTER ADD COLUMN IF NOT EXISTS
-- + CREATE INDEX IF NOT EXISTS。可在空库或现有库上反复执行。
-- 历史上 agents / server_members / action_cards / integrations / message_attachments /
-- agent_credentials / agent_logins / reminder_events 等表是手工建的、没有迁移，这里补齐。
-- ============================================================================

-- ---- users ----
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle VARCHAR(80) NOT NULL UNIQUE,
    display_name VARCHAR(80),
    description TEXT,
    avatar_url TEXT,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    token_version VARCHAR(64) DEFAULT gen_random_uuid()::text,
    nickname VARCHAR(80),
    reset_code VARCHAR(10),
    reset_expires TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version VARCHAR(64) DEFAULT gen_random_uuid()::text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- ---- servers（= 组织/协作组）----
CREATE TABLE IF NOT EXISTS servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id),
    personal BOOLEAN NOT NULL DEFAULT false,
    owner_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE servers ADD COLUMN IF NOT EXISTS personal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS owner_id UUID;
-- created_by 允许为空：自动播种的「默认服务器」在没有用户时也能建
ALTER TABLE servers ALTER COLUMN created_by DROP NOT NULL;

-- ---- server_members ----
CREATE TABLE IF NOT EXISTS server_members (
    server_id UUID NOT NULL REFERENCES servers(id),
    user_id UUID NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id)
);

-- ---- agents ----
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    server_id UUID NOT NULL REFERENCES servers(id),
    name VARCHAR(80) NOT NULL,
    display_name VARCHAR(80),
    description TEXT,
    avatar_url TEXT,
    runtime_profile JSONB DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    capabilities JSONB DEFAULT '[]'::jsonb,
    last_seen_seq BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_profile JSONB DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_seq BIGINT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_server_name ON agents (server_id, lower(name));

-- ---- channels ----
CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES servers(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    type VARCHAR(20) NOT NULL DEFAULT 'public',
    archived BOOLEAN NOT NULL DEFAULT false,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_server_name ON channels (server_id, lower(name));

-- ---- channel_members ----
CREATE TABLE IF NOT EXISTS channel_members (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    member_id UUID NOT NULL,
    member_type VARCHAR(10) NOT NULL CHECK (member_type IN ('human','agent')),
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, member_id, member_type)
);

-- ---- messages ----
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id),
    server_id UUID NOT NULL REFERENCES servers(id),
    sender_id UUID NOT NULL,
    sender_type VARCHAR(10) NOT NULL CHECK (sender_type IN ('human','agent','system')),
    content TEXT NOT NULL,
    seq BIGSERIAL NOT NULL,
    thread_id UUID REFERENCES messages(id),
    task_number INTEGER,
    task_status VARCHAR(20) CHECK (task_status IN ('todo','in_progress','in_review','done','closed')),
    task_assignee UUID,
    edited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_number INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_status VARCHAR(20);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_assignee UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_server_seq ON messages (server_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_task_status ON messages (channel_id, task_status) WHERE task_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING gin (to_tsvector('simple', content));

-- ---- message_reactions（user_id 不加外键：agent 也能反应）----
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    emoji VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

-- ---- attachments（uploader_id 不加外键：human/agent 都能传）----
CREATE TABLE IF NOT EXISTS attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploader_id UUID NOT NULL,
    uploader_type VARCHAR(10) NOT NULL DEFAULT 'human' CHECK (uploader_type IN ('human','agent')),
    filename VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    storage_key TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS uploader_type VARCHAR(10) NOT NULL DEFAULT 'human';

-- ---- message_attachments ----
CREATE TABLE IF NOT EXISTS message_attachments (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id UUID NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (message_id, attachment_id)
);

-- ---- machine_tokens ----
CREATE TABLE IF NOT EXISTS machine_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    server_id UUID NOT NULL REFERENCES servers(id),
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    token_prefix VARCHAR(20) NOT NULL,
    scope JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_machine_tokens_hash ON machine_tokens (token_hash);

-- ---- reminders（owner_id 不加外键：human/agent 都能拥有）----
CREATE TABLE IF NOT EXISTS reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL,
    title VARCHAR(500) NOT NULL,
    fire_at TIMESTAMPTZ NOT NULL,
    repeat_rule VARCHAR(200),
    channel_ref VARCHAR(200),
    anchor_msg_id UUID,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','fired','canceled')),
    fire_count INTEGER NOT NULL DEFAULT 0,
    last_fired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS fire_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS last_fired_at TIMESTAMPTZ;
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_owner_id_fkey;
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders (owner_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_status_fire ON reminders (status, fire_at) WHERE status = 'scheduled';

-- ---- reminder_events ----
CREATE TABLE IF NOT EXISTS reminder_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reminder_id UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    event_type VARCHAR(30) NOT NULL,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminder_events_reminder ON reminder_events (reminder_id, created_at);

-- ---- action_cards ----
CREATE TABLE IF NOT EXISTS action_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id),
    created_by UUID NOT NULL,
    target_user UUID NOT NULL REFERENCES users(id),
    action_type VARCHAR(50) NOT NULL,
    action_data JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- integrations ----
CREATE TABLE IF NOT EXISTS integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id VARCHAR(100) NOT NULL,
    name VARCHAR(200) NOT NULL,
    provider VARCHAR(100) NOT NULL,
    config JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- agent_credentials ----
CREATE TABLE IF NOT EXISTS agent_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL UNIQUE REFERENCES agents(id),
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    token_prefix VARCHAR(20) NOT NULL,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- agent_logins ----
CREATE TABLE IF NOT EXISTS agent_logins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    integration_id UUID NOT NULL REFERENCES integrations(id),
    access_token TEXT,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- user_sessions（登录设备/会话列表）----
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_id UUID NOT NULL,
    user_agent TEXT,
    ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_refresh ON user_sessions (refresh_id);

-- ---- 唯一索引（lower 大小写无关）----
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_lower ON users (lower(handle));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email)) WHERE email IS NOT NULL;
