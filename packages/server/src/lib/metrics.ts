// 轻量内存指标：进程级计数器 + 实时快照，供 GET /api/metrics 暴露。
// 多实例下各进程独立计数（无共享聚合），但足够单实例运维观测。

type CounterName = "messagesSent" | "dmSent" | "remindersFired" | "errors" | "logins";

const counters: Record<CounterName, number> = {
  messagesSent: 0,
  dmSent: 0,
  remindersFired: 0,
  errors: 0,
  logins: 0,
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
    },
    ...extra,
  };
}
