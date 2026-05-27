
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle VARCHAR(80) NOT NULL UNIQUE,
    display_name VARCHAR(80),
    description TEXT,
    avatar_url TEXT,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID REFERENCES servers(id) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    visibility VARCHAR(20) DEFAULT 'public' NOT NULL,
    archived BOOLEAN DEFAULT false NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(server_id, name)
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id UUID REFERENCES channels(id) NOT NULL,
    member_id UUID NOT NULL,
    member_type VARCHAR(10) NOT NULL,
    role VARCHAR(20) DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, member_id, member_type)
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID REFERENCES channels(id) NOT NULL,
    server_id UUID REFERENCES servers(id) NOT NULL,
    sender_id UUID NOT NULL,
    sender_type VARCHAR(10) NOT NULL,
    content TEXT NOT NULL,
    seq BIGSERIAL NOT NULL,
    thread_id UUID,
    task_number INTEGER,
    task_status VARCHAR(20),
    task_assignee UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id) WHERE thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    emoji VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploader_id UUID NOT NULL,
    filename VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    storage_key TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machine_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    server_id UUID REFERENCES servers(id) NOT NULL,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    token_prefix VARCHAR(20) NOT NULL,
    scope JSONB DEFAULT '{}' NOT NULL,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) NOT NULL,
    title VARCHAR(500) NOT NULL,
    fire_at TIMESTAMPTZ NOT NULL,
    repeat_rule VARCHAR(200),
    channel_ref VARCHAR(200),
    anchor_msg_id UUID,
    status VARCHAR(20) DEFAULT 'scheduled' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
