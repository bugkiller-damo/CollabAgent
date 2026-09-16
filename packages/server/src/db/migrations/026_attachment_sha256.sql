-- F10 附件 SHA256 去重（方案：docs/2026-09-16/01-file-upload-refactor-plan.md 批次二）。
-- sha256 允许 NULL：老数据不阻塞迁移，由 GC tick 顺带 best-effort 回填（lib/attachment-gc.ts
-- backfillSha256）；NULL 行不参与去重匹配（WHERE sha256 = $x 天然跳过）。
-- 部分索引只覆盖非 NULL 行：去重查找走索引，老数据回填前不占索引体积。
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS sha256 CHAR(64);
CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments (sha256) WHERE sha256 IS NOT NULL;
