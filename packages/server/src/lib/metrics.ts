// 轻量内存指标：进程级计数器 + 实时快照，供 GET /api/metrics 暴露。
// 多实例下各进程独立计数（无共享聚合），但足够单实例运维观测。

type CounterName =
  | "messagesSent"
  | "dmSent"
  | "remindersFired"
  | "patrolPosted"
  | "patrolSilent"
  | "patrolAutoPaused"
  | "errors"
  | "logins"
  | "machineAuthBcryptScans"
  | "machineAuthBcryptHits"
  | "machineAuthBcryptRejected";

const counters: Record<CounterName, number> = {
  messagesSent: 0,
  dmSent: 0,
  remindersFired: 0,
  patrolPosted: 0,
  patrolSilent: 0,
  patrolAutoPaused: 0,
  errors: 0,
  logins: 0,
  machineAuthBcryptScans: 0,
  machineAuthBcryptHits: 0,
  // P1.14：被护栏拒绝的 bcrypt 兼容路径进入尝试（速率超限/并发超时）——
  // 持续增长 = 存在 sk_machine_ 假令牌探测流量
  machineAuthBcryptRejected: 0,
};

const startedAt = Date.now();

export function inc(name: CounterName, n = 1): void {
  counters[name] = (counters[name] || 0) + n;
}

export function metricsSnapshot(extra?: Record<string, unknown>) {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    counters: { ...counters },
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
    },
    ...extra,
  };
}

/** 从 metrics_samples 最新行恢复计数器 */
export async function restoreCounters(pg: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}): Promise<void> {
  try {
    const r = await pg.query(
      "SELECT messages_sent, dm_sent, reminders_fired, errors, logins FROM metrics_samples ORDER BY sampled_at DESC LIMIT 1",
    );
    if (r.rows.length > 0) {
      const row = r.rows[0];
      counters.messagesSent = Number(row.messages_sent) || 0;
      counters.dmSent = Number(row.dm_sent) || 0;
      counters.remindersFired = Number(row.reminders_fired) || 0;
      counters.errors = Number(row.errors) || 0;
      counters.logins = Number(row.logins) || 0;
    }
  } catch {
    /* table may not exist yet */
  }
}
