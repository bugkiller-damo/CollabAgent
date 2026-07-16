import type { FastifyInstance } from "fastify";

export async function metricsRoutes(app: FastifyInstance) {
  app.get("/metrics", async () => {
    const { metricsSnapshot } = await import("../lib/metrics.js");
    const { daemonClients, daemonMeta } = await import("../ws/handler.js");
    let total = 0, online = 0;
    try {
      const r = await app.pg.query<{ user_id: string }>("SELECT user_id FROM agents");
      total = r.rows.length;
      online = r.rows.filter((a) => daemonClients.has(String(a.user_id))).length;
    } catch { /* ignore */ }
    return metricsSnapshot({
      online: { daemons: daemonClients.size, agents: total, agentsOnline: online },
      daemons: Array.from(daemonMeta.values()).map((d) => ({ hostname: d.hostname, daemonVersion: d.daemonVersion, runtimes: d.runtimes, connectedAt: d.connectedAt })),
    });
  });

  app.get("/metrics/history", async (req) => {
    const rangeHours: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 };
    const hours = rangeHours[String((req.query as Record<string, string>).range || "1h")] || 1;
    const r = await app.pg.query(`SELECT sampled_at, messages_sent, dm_sent, reminders_fired, errors, logins, rss_mb, heap_used_mb, heap_total_mb, daemon_count, agent_total, agent_online FROM metrics_samples WHERE sampled_at > now() - ($1 || ' hours')::interval ORDER BY sampled_at ASC`, [hours]);
    return { samples: r.rows };
  });
}
