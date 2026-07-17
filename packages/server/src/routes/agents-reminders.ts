import type { FastifyInstance } from "fastify";
import { initialFireAt, parseDurationToMs, reminderToDto } from "../lib/reminders.js";
import { requireOwnAgent } from "../lib/agent-helpers.js";

export async function agentReminderRoutes(app: FastifyInstance) {
  app.post("/:agentId/reminders", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const body = (req.body as Record<string, unknown>) || {};
    if (!body.title) return reply.status(400).send({ error: "title required" });
    const fireAt = initialFireAt(body);
    if (!fireAt) return reply.status(400).send({ error: "need fireAt, delaySeconds, or repeat" });
    const r = await app.pg.query("INSERT INTO reminders (owner_id, title, fire_at, repeat_rule, channel_ref, status) VALUES ($1, $2, $3, $4, $5, 'scheduled') RETURNING *", [agentId, body.title, fireAt.toISOString(), body.repeat || null, body.channel || null]);
    return { reminder: reminderToDto(r.rows[0]) };
  });

  app.get("/:agentId/reminders", { preHandler: [app.authenticate, requireOwnAgent] }, async (req) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { status } = req.query as Record<string, string>;
    const all = status === "all";
    const r = await app.pg.query("SELECT * FROM reminders WHERE owner_id = $1 " + (all ? "" : "AND status = 'scheduled'") + " ORDER BY fire_at ASC", [agentId]);
    return { reminders: r.rows.map(reminderToDto) };
  });

  app.delete("/:agentId/reminders/:reminderId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId, reminderId = (req.params as Record<string, string>).reminderId;
    const r = await app.pg.query("UPDATE reminders SET status = 'canceled', updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING id", [reminderId, agentId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    return { ok: true };
  });

  app.post("/:agentId/reminders/:reminderId/snooze", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId, reminderId = (req.params as Record<string, string>).reminderId;
    const ms = parseDurationToMs(String((req.body as { duration?: string })?.duration || ""));
    if (!ms) return reply.status(400).send({ error: "invalid duration (e.g. 30m, 2h)" });
    const cur = await app.pg.query<{ fire_at: string }>("SELECT fire_at FROM reminders WHERE id = $1 AND owner_id = $2", [reminderId, agentId]);
    if (cur.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    const next = new Date(Math.max(Date.now(), new Date(cur.rows[0]!.fire_at).getTime()) + ms);
    const r = await app.pg.query("UPDATE reminders SET fire_at = $1, status = 'scheduled', updated_at = now() WHERE id = $2 AND owner_id = $3 RETURNING *", [next.toISOString(), reminderId, agentId]);
    return { reminder: reminderToDto(r.rows[0]) };
  });

  app.patch("/:agentId/reminders/:reminderId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId, reminderId = (req.params as Record<string, string>).reminderId;
    const body = (req.body as Record<string, unknown>) || {};
    const sets: string[] = []; const params: any[] = []; let p = 1;
    if (body.title !== undefined) { sets.push(`title = $${p++}`); params.push(body.title); }
    if (body.repeat !== undefined) { sets.push(`repeat_rule = $${p++}`); params.push(body.repeat || null); }
    if (body.fireAt || body.delaySeconds != null) { const f = initialFireAt(body); if (f) { sets.push(`fire_at = $${p++}`); params.push(f.toISOString()); } }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    sets.push("updated_at = now()"); params.push(reminderId, agentId);
    const r = await app.pg.query(`UPDATE reminders SET ${sets.join(", ")} WHERE id = $${p++} AND owner_id = $${p} RETURNING *`, params);
    if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    return { reminder: reminderToDto(r.rows[0]) };
  });

  app.get("/:agentId/reminders/:reminderId/log", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId, reminderId = (req.params as Record<string, string>).reminderId;
    const r = await app.pg.query("SELECT * FROM reminders WHERE id = $1 AND owner_id = $2", [reminderId, agentId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    const dto = reminderToDto(r.rows[0]);
    return { reminder: dto, events: [{ event: "created", at: dto.createdAt }, ...(dto.lastFiredAt ? [{ event: "fired", at: dto.lastFiredAt, fireCount: dto.fireCount }] : []), { event: dto.status, at: r.rows[0].updated_at }] };
  });
}
