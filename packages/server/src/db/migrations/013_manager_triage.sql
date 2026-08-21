-- T8 频道经理自动分诊：频道级 opt-in 开关。
-- 设计文档：docs/2026-08-19/03-t8-manager-triage-design.md
-- 默认关——闲聊频道开了会每条无 @ 顶层消息唤醒经理。

ALTER TABLE channels ADD COLUMN IF NOT EXISTS manager_triage_enabled BOOLEAN NOT NULL DEFAULT false;
