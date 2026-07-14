import type { FastifyInstance } from "fastify";

export async function alertRoutes(app: FastifyInstance) {
  // ==================== 告警规则 CRUD ====================

  app.post("/rules", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { name, description, severity, metric, condition, channels, notifyIntervalMin, enabled } = req.body as any;
    if (!name || !severity || !metric || !condition) return reply.status(400).send({ error: "name, severity, metric, condition required" });
    const r = await app.pg.query(
      `INSERT INTO alert_rules (name, description, severity, metric, condition, channels, notify_interval_min, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, description || null, severity, metric, JSON.stringify(condition), channels || ["in_app"], notifyIntervalMin || 30, enabled !== false]
    );
    return { rule: r.rows[0] };
  });

  app.get("/rules", { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { subsidiaryId, enabled } = req.query as Record<string, string>;
    const c: string[] = []; const p: any[] = []; let i = 1;
    if (subsidiaryId) { c.push(`subsidiary_id = $${i++}`); p.push(subsidiaryId); }
    if (enabled !== undefined) { c.push(`enabled = $${i++}`); p.push(enabled === "true"); }
    const w = c.length ? `WHERE ${c.join(" AND ")}` : "";
    const r = await app.pg.query(`SELECT * FROM alert_rules ${w} ORDER BY severity DESC, created_at DESC`, p);
    return { rules: r.rows };
  });

  app.put("/rules/:ruleId", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const fields = req.body as Record<string, any>;
    const s: string[] = []; const p: any[] = []; let i = 1;
    for (const k of ["name", "description", "severity", "metric", "channels", "notify_interval_min", "enabled"]) {
      if (fields[k] !== undefined) {
        if (k === "condition") { s.push(`condition = $${i++}::jsonb`); p.push(JSON.stringify(fields[k])); }
        else if (k === "channels") { s.push(`channels = $${i++}`); p.push(fields[k]); }
        else { s.push(`${k} = $${i++}`); p.push(fields[k]); }
      }
    }
    if (s.length === 0) return reply.status(400).send({ error: "no fields" });
    s.push("updated_at = now()"); p.push(req.params.ruleId);
    const r = await app.pg.query(`UPDATE alert_rules SET ${s.join(", ")} WHERE id = $${i} RETURNING *`, p);
    if (r.rows.length === 0) return reply.status(404).send({ error: "rule not found" });
    return { rule: r.rows[0] };
  });

  app.delete("/rules/:ruleId", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const r = await app.pg.query("DELETE FROM alert_rules WHERE id = $1 RETURNING id", [req.params.ruleId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "rule not found" });
    return { deleted: true };
  });

  // ==================== 告警记录 ====================

  app.get("/history", { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { severity, status, subsidiaryId, page, pageSize, createdAfter, createdBefore, sortBy, order } = req.query as Record<string, string>;
    const c: string[] = []; const p: any[] = []; let i = 1;
    if (severity) { c.push(`a.severity = ANY($${i++})`); p.push(severity.split(",")); }
    if (status) { c.push(`a.status = ANY($${i++})`); p.push(status.split(",")); }
    if (subsidiaryId) { c.push(`a.subsidiary_id = $${i++}`); p.push(subsidiaryId); }
    if (createdAfter) { c.push(`a.created_at >= $${i++}`); p.push(createdAfter); }
    if (createdBefore) { c.push(`a.created_at <= $${i++}`); p.push(createdBefore); }
    const w = c.length ? `WHERE ${c.join(" AND ")}` : "";
    const lim = Math.min(parseInt(pageSize) || 20, 100);
    const off = ((parseInt(page) || 1) - 1) * lim;
    const sf = sortBy === "severity" ? "a.severity" : "a.created_at";
    const sd = order === "asc" ? "ASC" : "DESC";
    const cnt = Number((await app.pg.query(`SELECT count(*)::int as c FROM alerts a ${w}`, p)).rows[0]?.c ?? 0);
    const r = await app.pg.query(`SELECT a.* FROM alerts a ${w} ORDER BY ${sf} ${sd} LIMIT $${i} OFFSET $${i + 1}`, [...p, lim, off]);
    return { alerts: r.rows, pagination: { page: parseInt(page) || 1, pageSize: lim, totalCount: cnt, totalPages: Math.ceil(cnt / lim) } };
  });

  app.get("/stats", { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { subsidiaryId, days } = req.query as Record<string, string>;
    const d = parseInt(days) || 7;
    const cond = subsidiaryId
      ? `WHERE subsidiary_id = $1 AND created_at > now() - interval '${d} days'`
      : `WHERE created_at > now() - interval '${d} days'`;
    const params = subsidiaryId ? [subsidiaryId] : [];
    const bySev = await app.pg.query(`SELECT severity, count(*)::int as count FROM alerts ${cond} GROUP BY severity ORDER BY count DESC`, params);
    const bySta = await app.pg.query(`SELECT status, count(*)::int as count FROM alerts ${cond} GROUP BY status ORDER BY count DESC`, params);
    const total = Number((await app.pg.query(`SELECT count(*)::int as c FROM alerts ${cond}`, params)).rows[0]?.c ?? 0);
    return { total, bySeverity: bySev.rows, byStatus: bySta.rows };
  });

  app.post("/:alertId/acknowledge", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const userId = req.user.sub === "dev-user" ? "00000000-0000-0000-0000-000000000001" : req.user.sub;
    const r = await app.pg.query(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $1 WHERE id = $2 AND status = 'unacknowledged' RETURNING *`,
      [userId, req.params.alertId]
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "alert not found or already acknowledged" });
    return { alert: r.rows[0] };
  });
}
