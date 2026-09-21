-- Phase 5 §14.2：显式建模「USD 未计量」。
-- token-only runtime（LangChain/LangGraph worker 未配 cost_calculator）的回合
-- 不产生 costUsd——此前 daemon 记 0 美元、server 拒收非正行，UI 显示 $0.00
-- 冒充「已计量为零」。本迁移加 token 计数与未计量回合数，GREATEST 单调收敛
-- 语义与 cost_usd 一致（绝对值上报，重放不重复计）。
ALTER TABLE agent_cost_daily ADD COLUMN IF NOT EXISTS unmetered_turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_cost_daily ADD COLUMN IF NOT EXISTS input_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_cost_daily ADD COLUMN IF NOT EXISTS output_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_cost_daily ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0;
