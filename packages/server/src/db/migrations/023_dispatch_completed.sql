-- P1.26：dispatch 增加 completed 终态 + 经理验收端点。
-- 007 的内联 CHECK（约束名实锤为 dispatches_status_check，pg_constraint 核对）
-- 只放行 open/reported/cancelled——worker 回报（reported）之后没有闭环，
-- 经理无验收端点，看板卡片停在 in_review 永挂（评估报告 §1 agents-dispatch 中危项）。
-- 放宽约束放行 'completed'，并加 completed_at 记录验收时刻。
ALTER TABLE dispatches DROP CONSTRAINT IF EXISTS dispatches_status_check;
ALTER TABLE dispatches ADD CONSTRAINT dispatches_status_check
  CHECK (status IN ('open', 'reported', 'cancelled', 'completed'));
ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
