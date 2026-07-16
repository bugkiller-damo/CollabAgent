import type { FastifyInstance } from "fastify";
import { agentCanAccessChannel, resolveChannelByName } from "../lib/agent-helpers.js";

const STATUSES = ["todo", "in_progress", "in_review", "done", "closed"];

export async function agentTaskRoutes(app: FastifyInstance) {
  app.get("/:agentId/tasks", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, status } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    let q = "SELECT id, content, task_number, task_status, task_assignee, created_at FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL";
    const p: any[] = [ch.id];
    if (status && status !== "all") { p.push(status); q += ` AND task_status = $${p.length}`; }
    return { tasks: (await app.pg.query(q + " ORDER BY task_number ASC", p)).rows };
  });

  app.post("/:agentId/tasks", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, tasks } = req.body as { channel?: string; tasks?: { title: string }[] };
    if (!channel || !tasks?.length) return reply.status(400).send({ error: "channel and tasks required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const maxNum = await app.pg.query<{ n: number }>("SELECT COALESCE(MAX(task_number), 0) as n FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL", [ch.id]);
    let next = Number(maxNum.rows[0]!.n);
    const created: any[] = [];
    for (const t of tasks) {
      next++;
      const r = await app.pg.query("INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, task_number, task_status) VALUES ($1, $2, $3, 'agent', $4, $5, 'todo') RETURNING id, task_number, content", [ch.id, ch.server_id, agentId, t.title, next]);
      created.push(r.rows[0]);
    }
    return { tasks: created };
  });

  app.post("/:agentId/tasks/claim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, task_numbers, message_ids } = req.body as { channel?: string; task_numbers?: number[]; message_ids?: string[] };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const nums: number[] = [...(task_numbers || [])];
    for (const mid of (message_ids || [])) {
      const r = await app.pg.query("SELECT task_number FROM messages WHERE id = $1 AND channel_id = $2", [mid, ch.id]);
      if (r.rows[0]?.task_number != null) nums.push(Number(r.rows[0].task_number));
    }
    const results: any[] = [];
    for (const num of nums) {
      const m = (await app.pg.query<{ task_status: string | null; task_assignee: string | null }>("SELECT task_status, task_assignee FROM messages WHERE channel_id = $1 AND task_number = $2", [ch.id, num])).rows[0];
      if (!m) { results.push({ number: num, status: "conflict", error: "not_found" }); continue; }
      if (m.task_status === "done" || m.task_status === "closed") { results.push({ number: num, status: "conflict", error: "task_is_done" }); continue; }
      if (m.task_assignee && String(m.task_assignee) !== String(agentId)) { results.push({ number: num, status: "conflict", error: "already_claimed_by_other" }); continue; }
      await app.pg.query("UPDATE messages SET task_status = 'in_progress', task_assignee = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3", [agentId, ch.id, num]);
      results.push({ number: num, status: "claimed" });
    }
    return { results };
  });

  app.post("/:agentId/tasks/unclaim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, task_number } = req.body as { channel?: string; task_number?: number };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    await app.pg.query("UPDATE messages SET task_assignee = NULL, task_status = 'todo', updated_at = now() WHERE channel_id = $1 AND task_number = $2", [ch.id, task_number]);
    return { ok: true };
  });

  app.post("/:agentId/tasks/update-status", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, number, status } = req.body as { channel?: string; number?: number; status?: string };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    if (!status || !STATUSES.includes(status)) return reply.status(400).send({ error: `invalid status: ${status}` });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const r = await app.pg.query("UPDATE messages SET task_status = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3 RETURNING id, task_number, task_status", [status, ch.id, number]);
    return { ok: true, task: r.rows[0] };
  });
}
