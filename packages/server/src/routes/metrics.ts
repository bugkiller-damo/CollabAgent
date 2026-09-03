import type { FastifyInstance } from "fastify";

export async function metricsRoutes(app: FastifyInstance) {
  app.get("/metrics", { preHandler: [app.authenticate] }, async () => {
    const { metricsSnapshot } = await import("../lib/metrics.js");
    const { onlineUserSnapshot } = await import("../lib/presence.js");
    const { daemonClients, daemonMeta } = await import("../ws/handler.js");
    // P1.27：在线计数走跨实例并集（daemon 连在其他实例也计入）；
    // daemons 明细数组仍是本实例视角（daemonMeta 只记本地连接），daemonsLocal 供对照。
    const onlineUsers = onlineUserSnapshot();
    let total = 0,
      online = 0;
    try {
      const r = await app.pg.query<{ user_id: string }>("SELECT user_id FROM agents");
      total = r.rows.length;
      online = r.rows.filter((a) => onlineUsers.has(String(a.user_id))).length;
    } catch {
      /* ignore */
    }
    return metricsSnapshot({
      online: { daemons: onlineUsers.size, daemonsLocal: daemonClients.size, agents: total, agentsOnline: online },
      daemons: Array.from(daemonMeta.values()).map((d) => ({
        hostname: d.hostname,
        daemonVersion: d.daemonVersion,
        os: d.os,
        arch: d.arch,
        runtimes: d.runtimes.map((r) => (r.status === "installed" ? r.id : `${r.id}:${r.status}`)),
        connectedAt: d.connectedAt,
      })),
    });
  });

  app.get("/metrics/history", { preHandler: [app.authenticate] }, async (req) => {
    const rangeHours: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 };
    const hours = rangeHours[String((req.query as Record<string, string>).range || "1h")] || 1;
    // P1.27：samples 带 instance 标识——多实例部署下同表混存各实例采样行，消费方可按实例分组
    const r = await app.pg.query(
      `SELECT sampled_at, instance, messages_sent, dm_sent, reminders_fired, errors, logins, rss_mb, heap_used_mb, heap_total_mb, daemon_count, agent_total, agent_online FROM metrics_samples WHERE sampled_at > now() - ($1 || ' hours')::interval ORDER BY sampled_at ASC`,
      [hours],
    );
    return { samples: r.rows };
  });
}
