// 轻量内存指标：进程级计数器 + 实时快照，供 GET /api/metrics 暴露。
// 多实例下各进程独立计数（P1.27 起每行采样带 instance 标识，恢复按本实例行取）。
import { hostname } from "node:os";

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
  | "machineAuthBcryptRejected"
  | "wsSlowConsumerTerminated";

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
  // P1.22：WS 慢消费者背压 terminate（bufferedAmount 超阈值）——
  // 持续增长 = 有客户端长期跟不上帧速率（网络/机器问题），配合重连补拉自愈
  wsSlowConsumerTerminated: 0,
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

/**
 * P1.27：实例标识——metrics_samples.instance 列的写入与恢复口径，稳定性优先：
 * 同一部署槽重启后 restoreCounters 要能找回「自己上一世」的累计值。
 * SLOCK_INSTANCE_ID 显式指定（多实例部署应逐实例配置）；缺省回退主机名
 * （单实例天然稳定；同机多进程共用标识会互相接管累计值——跨机多实例不受影响，
 * 同机多实例请显式配置）。
 */
export function instanceId(): string {
  return process.env.SLOCK_INSTANCE_ID || hostname();
}

/** 从 metrics_samples 恢复全部累计计数器（P1.27：此前仅恢复 5/12，patrol、machineAuth 系列、wsSlow 重启清零） */
export async function restoreCounters(
  pg: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  },
  instance: string = instanceId(),
): Promise<void> {
  // 024 起新列全量持久化；旧行（024 前写入）新列为 0（DEFAULT 0 回填），不虚增
  const cols =
    "messages_sent, dm_sent, reminders_fired, patrol_posted, patrol_silent, patrol_auto_paused, " +
    "machine_auth_bcrypt_scans, machine_auth_bcrypt_hits, machine_auth_bcrypt_rejected, " +
    "ws_slow_consumer_terminated, errors, logins";
  try {
    let r = await pg.query(`SELECT ${cols} FROM metrics_samples WHERE instance = $1 ORDER BY sampled_at DESC LIMIT 1`, [
      instance,
    ]);
    if (r.rows.length === 0) {
      // 024 升级后首启：本实例还没有带 instance 的行 → 回退全表最新行（旧版行为），
      // 保住旧 5 计数器的跨重启连续性。多实例下首启会接管他实例的计数一次，
      // 随后本实例自有行（60s 内写出）即接管恢复口径—— bounded 一次性代价。
      r = await pg.query(`SELECT ${cols} FROM metrics_samples ORDER BY sampled_at DESC LIMIT 1`);
    }
    if (r.rows.length > 0) {
      const row = r.rows[0];
      counters.messagesSent = Number(row.messages_sent) || 0;
      counters.dmSent = Number(row.dm_sent) || 0;
      counters.remindersFired = Number(row.reminders_fired) || 0;
      counters.patrolPosted = Number(row.patrol_posted) || 0;
      counters.patrolSilent = Number(row.patrol_silent) || 0;
      counters.patrolAutoPaused = Number(row.patrol_auto_paused) || 0;
      counters.machineAuthBcryptScans = Number(row.machine_auth_bcrypt_scans) || 0;
      counters.machineAuthBcryptHits = Number(row.machine_auth_bcrypt_hits) || 0;
      counters.machineAuthBcryptRejected = Number(row.machine_auth_bcrypt_rejected) || 0;
      counters.wsSlowConsumerTerminated = Number(row.ws_slow_consumer_terminated) || 0;
      counters.errors = Number(row.errors) || 0;
      counters.logins = Number(row.logins) || 0;
    }
  } catch {
    /* table may not exist yet */
  }
}
