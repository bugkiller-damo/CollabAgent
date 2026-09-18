-- ============================================================================
-- 028_agent_visibility_consents.sql — 2026-09-17 用户级可见性审计批次
--
-- 两个属主开关（默认关，均由 agent 属主经 PATCH /api/agents/:agentId 设置）：
--   allow_terminal_watch：允许「频道同事」观看该 agent 的终端实时流/回放；
--   consent_channel_invite：公开频道 @提及自动入圈（征用）的属主 opt-in。
-- ============================================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS allow_terminal_watch BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS consent_channel_invite BOOLEAN NOT NULL DEFAULT false;
