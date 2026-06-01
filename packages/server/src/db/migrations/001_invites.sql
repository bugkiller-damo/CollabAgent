-- 工作区邀请链接：owner 生成带 token 的链接，新同事用链接注册后自动加入对应 server。
CREATE TABLE IF NOT EXISTS invites (
    token VARCHAR(64) PRIMARY KEY,
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    max_uses INT,                          -- NULL = 不限次数
    uses INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,                 -- NULL = 永不过期
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites (server_id);
