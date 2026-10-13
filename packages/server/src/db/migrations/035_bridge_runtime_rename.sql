-- 035_bridge_runtime_rename.sql：bridge runtime 标识统一（langchain / langgraph → bridge）
-- WP6：agents.runtime_profile->>'runtime' 的旧别名改写为归一值 "bridge"。
-- 备份表 agents_runtime_profile_bak_035 供回滚恢复（回滚先恢复本表再 revert 代码）。
-- computers.entrypoints 快照不迁移——daemon 下次 ready / entrypoints:refresh 会覆盖，
-- 读取路径由 normalizeEntrypoints 归一兜底。
CREATE TABLE IF NOT EXISTS agents_runtime_profile_bak_035 AS
  SELECT id, runtime_profile FROM agents
  WHERE runtime_profile->>'runtime' IN ('langchain', 'langgraph');

UPDATE agents
SET runtime_profile = jsonb_set(runtime_profile, '{runtime}', '"bridge"')
WHERE runtime_profile->>'runtime' IN ('langchain', 'langgraph');
