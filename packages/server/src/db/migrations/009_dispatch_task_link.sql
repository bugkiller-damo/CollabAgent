-- dispatch 与看板任务的关联（P1 同步）：dispatch 创建时，其 📋 通知消息同步成为
-- 看板卡片（messages.task_number/task_status/task_assignee），dispatch 状态流转
-- （reported/cancelled）驱动任务状态（in_review/closed）。
-- 不加 FK：消息删除时 task 字段被清空（messages.ts 删除逻辑），这里悬空无害。
ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS task_message_id UUID;
