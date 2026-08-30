/**
 * 任务取号互斥（评估报告 P0.5）。
 *
 * MAX+1 取号在 READ COMMITTED 下会重号：两个并发事务都读到同一个 MAX，随后各自
 * 写不同的消息行——行锁互不阻塞，双双提交即产生重复 task_number（dispatch 卡片
 * 与 /from-message 的单语句 UPDATE 同样中招，「单语句」不等于「原子」）。
 *
 * 防线一（本函数）：取号路径先拿频道级 advisory lock 串行化，持锁到事务提交，
 * 锁内读 MAX + 写入即安全。防线二：018 迁移的部分唯一索引兜底（防漏网与回归，
 * 唯一冲突会以 23505 硬失败而不是静默重号）。
 *
 * 锁键空间独立于 messages.ts 的 seq 串行锁（'taskno:' 前缀），任务取号不与消息
 * 发送互斥。
 */
export async function acquireTaskNumberLock(
  tx: { query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[] }> },
  channelId: string,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('taskno:' || $1, 0))", [channelId]);
}
