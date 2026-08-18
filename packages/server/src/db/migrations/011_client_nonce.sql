-- 消息发送幂等（O15 离线同步）：client_nonce 是客户端生成的去重键。
--
-- 设计要点：
-- - 客户端发送前生成随机 nonce（离线队列重放、双击重试、断线重发都复用同一 nonce）；
-- - 部分唯一索引 (channel_id, client_nonce) WHERE client_nonce IS NOT NULL：
--   同一频道内 nonce 唯一，跨频道互不影响，存量/无 nonce 的 NULL 行不进索引；
-- - 服务端 INSERT ... ON CONFLICT DO NOTHING，冲突即「幂等重放」：返回首条消息的
--   id/seq，不重复写消息行、审计事件、通知与广播。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_nonce TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_client_nonce
  ON messages (channel_id, client_nonce) WHERE client_nonce IS NOT NULL;
