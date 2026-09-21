-- Phase 5：agent 写操作幂等（§15.4.5）。
-- SARP/1 worker 的工具调用在 A1 重试 / worker 崩溃重放时会重复发出 send_message /
-- dispatch_task。SDK 按 <turnId>:<toolName>:<seq> 生成稳定 idempotencyKey——
-- 重跑同一回合产生的第 n 次同名写调用撞同一个键，server 去重后返回首次结果。
--
-- send_message 复用 messages.client_nonce（值前缀 ag:<agentId>: 限定 agent 作用域）；
-- dispatch 没有消息列可复用，单独加列 + 部分唯一索引（作用域 = 频道 x 经理 agent）。
ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_idempotency_key
  ON dispatches (channel_id, from_agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
