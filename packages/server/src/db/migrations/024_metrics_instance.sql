-- P1.27：metrics_samples 实例化——多实例部署下各进程独立采样混存同表：
-- instance 列标识采样来源（SLOCK_INSTANCE_ID 或主机名，lib/metrics.ts instanceId()），
-- restoreCounters 按「本实例最新行」恢复累计计数器；并补齐此前未持久化的
-- 7 个计数器列（patrol/machineAuth*/wsSlow——重启清零的观测缺口）。
-- 存量行回填 instance='default'：单实例升级后首启经 legacy 回退（restoreCounters
-- 无本实例行时取全表最新行）接续旧 5 计数器，60s 内自有行即接管恢复口径。
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT 'default';
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS patrol_posted BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS patrol_silent BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS patrol_auto_paused BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS machine_auth_bcrypt_scans BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS machine_auth_bcrypt_hits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS machine_auth_bcrypt_rejected BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_samples ADD COLUMN IF NOT EXISTS ws_slow_consumer_terminated BIGINT NOT NULL DEFAULT 0;
-- 按 (instance, sampled_at) 取本实例最新行 + history 按实例过滤
CREATE INDEX IF NOT EXISTS idx_metrics_instance_time ON metrics_samples (instance, sampled_at DESC);
