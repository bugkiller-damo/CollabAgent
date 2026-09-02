import type { FastifyInstance } from "fastify";

// P1.25：notifications TTL 清理——仅清「已读且超 30 天」的行。未读是用户待办，
// 静默删除等于丢通知（未读永不自动清；表增长由「已读清理 + 用户全部已读」兜底，
// unread 部分索引 idx_notifications_unread 保证未读计数查询不受表体增长影响）。
// 导出以便测试直调（metrics-persist tick 60s 一次，测试不等周期）。
export async function purgeReadNotifications(app: FastifyInstance): Promise<void> {
  await app.pg.query("DELETE FROM notifications WHERE read = true AND created_at < now() - interval '30 days'");
}

// 周期采样进程指标并写入 metrics_samples 表，用于跨重启趋势展示。
// 镜像 reminder-scheduler.ts 模式：setInterval + try/catch 隔离 + 返回 cleanup。
export function startMetricsPersistence(app: FastifyInstance, intervalMs = 60000): () => void {
  const tick = async () => {
    try {
      const { metricsSnapshot } = await import("./metrics.js");
      const { daemonClients } = await import("../ws/handler.js");

      const snap = metricsSnapshot();

      let agentTotal = 0;
      let agentOnline = 0;
      try {
        const r = await app.pg.query<{ user_id: string }>("SELECT user_id FROM agents");
        agentTotal = r.rows.length;
        agentOnline = r.rows.filter((a) => daemonClients.has(String(a.user_id))).length;
      } catch {
        /* agents table may not exist during early startup */
      }

      await app.pg.query(
        `INSERT INTO metrics_samples
           (sampled_at, messages_sent, dm_sent, reminders_fired, errors, logins,
            rss_mb, heap_used_mb, heap_total_mb,
            daemon_count, agent_total, agent_online)
         VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          snap.counters.messagesSent,
          snap.counters.dmSent,
          snap.counters.remindersFired,
          snap.counters.errors,
          snap.counters.logins,
          snap.memory.rssMb,
          snap.memory.heapUsedMb,
          snap.memory.heapTotalMb,
          daemonClients.size,
          agentTotal,
          agentOnline,
        ],
      );

      // 清理 7 天前旧数据（best-effort，不阻断采样）
      await app.pg.query("DELETE FROM metrics_samples WHERE sampled_at < now() - interval '7 days'").catch(() => {});

      // P1.25：notifications 已读行 TTL 清理（best-effort，语义见 purgeReadNotifications 注释）
      await purgeReadNotifications(app).catch(() => {});
    } catch (err) {
      console.error("[Metrics] persist error:", (err as Error).message);
    }
  };

  // 启动后先采样一次，之后每 intervalMs 采样一次
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
