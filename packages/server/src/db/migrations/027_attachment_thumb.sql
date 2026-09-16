-- F11 附件缩略图（方案：docs/2026-09-16/01-file-upload-refactor-plan.md 批次二）。
-- thumb_key 指向 `<storage_key>.thumb.webp`（≤400px webp）；NULL = 无缩略图
-- （非图片 / sharp 生成失败降级 / F11 前存量）。不加索引：只按行读出，不按键查。
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumb_key TEXT;
