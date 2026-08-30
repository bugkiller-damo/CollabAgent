-- P0.5：任务号唯一性兜底。
-- MAX+1 取号在 READ COMMITTED 并发下会重号（dispatch 卡片 / from-message / 建任务
-- 三类路径），此前无唯一约束，重号会静默落库并让 claim/看板按 task_number 定位时串任务。
-- 历史竞态若已产生重号，先去重再建唯一索引（否则迁移失败 → 启动失败）：
-- 每组 (channel_id, task_number) 保留最早一条，其余按「频道当前 MAX + 序号」顺延重号，
-- 不丢任务卡片。无重号时本语句零行更新、零影响。
WITH chmax AS (
  SELECT channel_id, COALESCE(MAX(task_number), 0) AS mx
  FROM messages
  WHERE task_number IS NOT NULL
  GROUP BY channel_id
),
dup AS (
  SELECT id, channel_id, created_at,
         ROW_NUMBER() OVER (PARTITION BY channel_id, task_number ORDER BY created_at, id) AS rn
  FROM messages
  WHERE task_number IS NOT NULL
),
dupseq AS (
  SELECT id, channel_id,
         ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY created_at, id) AS seq
  FROM dup
  WHERE rn > 1
)
UPDATE messages m
SET task_number = (SELECT mx FROM chmax WHERE chmax.channel_id = dupseq.channel_id) + dupseq.seq,
    updated_at = now()
FROM dupseq
WHERE m.id = dupseq.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_task_number
  ON messages (channel_id, task_number) WHERE task_number IS NOT NULL;
