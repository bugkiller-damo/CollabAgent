-- ============================================================================
-- 031_drop_personal_server_semantics.sql — 2026-09-19 取消 personal server 特例
--
-- 产品决策：「个人空间」与自建 server 完全同构，取消兜底语义——
--   GET /api/orgs 不再懒建 personal org；POST /agents 与 machine-token 必须
--   显式 serverId；owner 踢出 agent 重指属主最早拥有的 server（不再是兜底
--   个人空间）；DM「共有社区」不再排除 personal。
-- 数据语义：存量 personal server 翻转标记即变普通私有 server（名称保留
--   "X 的私有空间"，可改名/可删/可转）——数据不丢，无重建。
-- 列保留：servers.personal 自此不再有代码写 true（DEFAULT false），留作
--   inert 历史列，待后续清理批再 DROP。
-- ============================================================================

UPDATE servers SET personal = false WHERE personal = true;
