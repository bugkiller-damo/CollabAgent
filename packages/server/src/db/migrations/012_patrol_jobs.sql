-- T2 patrol jobs：reminders 表从「闹钟语义」扩展为「任务语义」。
-- 设计文档：docs/2026-08-19/02-t2-agent-patrol-design.md
-- 要点：
-- - kind 分流：'reminder'（默认，人的小闹钟，行为不变）| 'patrol'（agent 周期巡检任务）；
-- - instructions：巡检任务指令（fire 时注入 prompt，替代仅有的 title）；
-- - paused：独立布尔列（不动 status CHECK 约束，纯增量）；paused 行不被 scheduler 认领；
-- - consecutive_silent / max_consecutive_silent：空转护栏——连续沉默达阈值自动 paused，
--   防「无异常也每次刷屏」与失控循环。

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'reminder';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS consecutive_silent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS max_consecutive_silent INTEGER NOT NULL DEFAULT 5;

-- patrol 到期认领走这个部分索引（与人的 reminder 扫描互不干扰）
CREATE INDEX IF NOT EXISTS idx_reminders_patrol_due
  ON reminders (status, fire_at)
  WHERE status = 'scheduled' AND kind = 'patrol' AND NOT paused;
