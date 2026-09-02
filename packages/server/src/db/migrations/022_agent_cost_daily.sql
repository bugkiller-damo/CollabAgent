-- P1.24：daemon→server 成本上报落库表。
-- 此前 daemon 成本记账纯本地（.slock/daemon-costs.json），server/Web 侧成本观测
-- 完全断链（people stats costUsd 恒 null 硬编码）。
--
-- 键 = (agent_id, channel, day)：
--   * channel 为 daemon 归一化频道名（normalizeCostChannel：去 #、去 thread 后缀；
--     DM 归并为 "dm"，未识别落 "unknown"）——是账本键不是 channel 外键，
--     无法可靠回链 channels.id（DM 归并），故存名不存 uuid；
--   * day 为 UTC 日历日（daemon utcDay）。
--
-- 上报语义：daemon 定期上报本地账本的「当日累计绝对值」，server UPSERT 取
-- GREATEST 单调收敛——重试 / 乱序 / 账本重置都不会重复计费，无需 ack 协议。
-- 差值语义在 daemon 侧已完成：账本本身由 createSessionCostDelta 按
-- 「本次 total_cost_usd − 上次」增量累计，server 存的即增量之和，不是会话累计原值。
CREATE TABLE IF NOT EXISTS agent_cost_daily (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    channel VARCHAR(128) NOT NULL DEFAULT 'unknown',
    day DATE NOT NULL,
    cost_usd NUMERIC(14, 6) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, channel, day)
);

-- people stats 的 human 对端按名下 agents 聚合走 day 前缀；agent 对端走 PK 前缀，无需另建
CREATE INDEX IF NOT EXISTS idx_agent_cost_daily_day ON agent_cost_daily (day);
