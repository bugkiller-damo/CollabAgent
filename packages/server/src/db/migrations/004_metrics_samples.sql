-- Metrics 持久化：定时采样的进程指标快照，用于跨重启趋势展示。
-- 采样间隔 60 秒，保留 7 天（调度器周期性清理旧数据）。
CREATE TABLE IF NOT EXISTS metrics_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- 累计计数器
    messages_sent BIGINT NOT NULL DEFAULT 0,
    dm_sent BIGINT NOT NULL DEFAULT 0,
    reminders_fired BIGINT NOT NULL DEFAULT 0,
    errors BIGINT NOT NULL DEFAULT 0,
    logins BIGINT NOT NULL DEFAULT 0,

    -- 内存
    rss_mb INTEGER NOT NULL DEFAULT 0,
    heap_used_mb INTEGER NOT NULL DEFAULT 0,
    heap_total_mb INTEGER NOT NULL DEFAULT 0,

    -- 在线状态
    daemon_count INTEGER NOT NULL DEFAULT 0,
    agent_total INTEGER NOT NULL DEFAULT 0,
    agent_online INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_metrics_sampled_at ON metrics_samples (sampled_at DESC);
