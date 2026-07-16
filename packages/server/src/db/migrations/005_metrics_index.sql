-- 加速 metrics_samples 时序范围查询和清理
CREATE INDEX IF NOT EXISTS idx_metrics_sampled_at ON metrics_samples (sampled_at DESC);
