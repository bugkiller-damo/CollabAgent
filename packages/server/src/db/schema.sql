-- CollabAgent Database Schema (PostgreSQL 15+)

-- Users
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle      VARCHAR(80) NOT NULL UNIQUE,
    display_name VARCHAR(80),
    description TEXT,
    avatar_url  TEXT,
    password_hash VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_users_handle_lower ON users (lower(handle));

-- Servers
CREATE TABLE servers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    created_by  UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agents
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    server_id       UUID NOT NULL REFERENCES servers(id),
    name            VARCHAR(80) NOT NULL,
    display_name    VARCHAR(80),
    description     TEXT,
    avatar_url      TEXT,
    runtime_profile JSONB DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    capabilities    JSONB DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_agents_server_name ON agents (server_id, lower(name));

-- Channels
CREATE TABLE channels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id),
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    type        VARCHAR(20) NOT NULL DEFAULT 'public',
    archived    BOOLEAN NOT NULL DEFAULT false,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_channels_server_name ON channels (server_id, lower(name));

-- Channel members
CREATE TABLE channel_members (
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    member_id   UUID NOT NULL,
    member_type VARCHAR(10) NOT NULL CHECK (member_type IN ('human', 'agent')),
    role        VARCHAR(20) DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, member_id, member_type)
);

-- Messages
CREATE TABLE messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id),
    server_id   UUID NOT NULL REFERENCES servers(id),
    sender_id   UUID NOT NULL,
    sender_type VARCHAR(10) NOT NULL CHECK (sender_type IN ('human', 'agent', 'system')),
    content     TEXT NOT NULL,
    seq         BIGSERIAL NOT NULL,
    thread_id   UUID REFERENCES messages(id),
    task_number INTEGER,
    task_status VARCHAR(20) CHECK (task_status IN ('todo', 'in_progress', 'in_review', 'done', 'closed')),
    task_assignee UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_messages_channel_seq ON messages (channel_id, seq);
CREATE INDEX idx_messages_thread ON messages (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX idx_messages_sender ON messages (sender_id);
CREATE INDEX idx_messages_task_status ON messages (channel_id, task_status) WHERE task_number IS NOT NULL;
CREATE INDEX idx_messages_search ON messages USING GIN (to_tsvector('simple', content));
CREATE INDEX idx_messages_server_seq ON messages (server_id, seq);

-- Message reactions
CREATE TABLE message_reactions (
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id),
    emoji       VARCHAR(16) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

-- Attachments
CREATE TABLE attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploader_id UUID NOT NULL,
    uploader_type VARCHAR(10) NOT NULL CHECK (uploader_type IN ('human', 'agent')),
    filename    VARCHAR(500) NOT NULL,
    mime_type   VARCHAR(100) NOT NULL,
    size_bytes  BIGINT NOT NULL,
    storage_key TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Message attachments junction
CREATE TABLE message_attachments (
    message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id UUID NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (message_id, attachment_id)
);

-- Reminders
CREATE TABLE reminders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      UUID NOT NULL REFERENCES users(id),
    title         VARCHAR(500) NOT NULL,
    fire_at       TIMESTAMPTZ NOT NULL,
    repeat_rule   VARCHAR(200),
    channel_ref   VARCHAR(200),
    anchor_msg_id UUID,
    status        VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'fired', 'canceled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reminders_status_fire ON reminders (status, fire_at) WHERE status = 'scheduled';
CREATE INDEX idx_reminders_owner ON reminders (owner_id);

-- Reminder event log
CREATE TABLE reminder_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reminder_id UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    event_type  VARCHAR(30) NOT NULL,
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reminder_events_reminder ON reminder_events (reminder_id, created_at);

-- Machine tokens
CREATE TABLE machine_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id),
    server_id   UUID NOT NULL REFERENCES servers(id),
    token_hash  VARCHAR(128) NOT NULL UNIQUE,
    token_prefix VARCHAR(20) NOT NULL,
    scope       JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_machine_tokens_hash ON machine_tokens (token_hash);

-- Agent credentials
CREATE TABLE agent_credentials (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID NOT NULL UNIQUE REFERENCES agents(id),
    token_hash  VARCHAR(128) NOT NULL UNIQUE,
    token_prefix VARCHAR(20) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);

-- Integrations
CREATE TABLE integrations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  VARCHAR(100) NOT NULL,
    name        VARCHAR(200) NOT NULL,
    provider    VARCHAR(100) NOT NULL,
    config      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent logins for integrations
CREATE TABLE agent_logins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id),
    integration_id  UUID NOT NULL REFERENCES integrations(id),
    access_token    TEXT,
    refresh_token   TEXT,
    expires_at      TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Action cards
CREATE TABLE action_cards (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id),
    created_by  UUID NOT NULL,
    target_user UUID NOT NULL REFERENCES users(id),
    action_type VARCHAR(50) NOT NULL,
    action_data JSONB NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
