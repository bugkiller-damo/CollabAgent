-- ============================================================================
-- 029_server_is_public.sql — 2026-09-18 两类 server 权限模型：广场标记显式化
--
-- servers.is_public：公共服务器（对全体用户开放——注册自动入圈 + 已登录可
-- 自助 POST /api/orgs/:id/join）。personal 自此降级为纯来源标签（onboarding
-- 命名/UI 标记/设施重指优先落点），不再承担拒退/拒删/拒转等能力差异。
--
-- 广场判定从「最早非 personal server」启发式升格为显式列：回填最早非
-- personal server 为公共服务器（与 getDefaultServerId/isInstanceAdmin 的
-- 回退口径一致——is_public 命中前两者仍可按启发式兜底）。
-- ============================================================================

ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

UPDATE servers SET is_public = true
 WHERE id = (SELECT id FROM servers WHERE personal = false ORDER BY created_at ASC LIMIT 1);
