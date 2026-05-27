import type { FastifyInstance } from "fastify";

const STATUSES = ["todo", "in_progress", "in_review", "done", "closed"];

export async function taskRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, status } = req.query as any;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const name = channel.startsWith("#") ? channel.slice(1) : channel;
    const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    let query = "SELECT * FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL";
    const params: any[] = [ch.rows[0].id];
    if (status && status !== "all") {
      params.push(status);
      query += ` AND task_status = $${params.length}`;
    }
    query += " ORDER BY task_number ASC";
    const result = await app.pg.query(query, params);
    return { tasks: result.rows };
  });

  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, tasks } = req.body as any;
    if (!channel || !tasks?.length) return reply.status(400).send({ error: "channel and tasks required" });
    const ch = await app.pg.query("SELECT id, server_id FROM channels WHERE name = $1", [channel]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    const userId = (req as any).user.sub;
    const maxNum = await app.pg.query(
      "SELECT COALESCE(MAX(task_number), 0) as n FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL",
      [ch.rows[0].id]
    );
    let next = Number((maxNum.rows[0] as any).n);
    const created: any[] = [];
    for (const t of tasks) {
      next++;
      const result = await app.pg.query(
        `INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, task_number, task_status)
         VALUES ($1, $2, $3, 'human', $4, $5, 'todo') RETURNING id, task_number, content`,
        [ch.rows[0].id, ch.rows[0].server_id, userId, t.title, next]
      );
      created.push(result.rows[0]);
    }
    return { tasks: created };
  });

  app.post("/claim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, task_numbers, message_ids } = req.body as any;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [channel]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    const userId = (req as any).user.sub;
    const results: any[] = [];
    for (const num of (task_numbers || [])) {
      const existing = await app.pg.query(
        "SELECT * FROM messages WHERE channel_id = $1 AND task_number = $2", [ch.rows[0].id, num]
      );
      if (existing.rows.length === 0) {
        results.push({ number: num, status: "conflict", error: "not_found" });
        continue;
      }
      const msg = existing.rows[0];
      if (msg.task_status === "done" || msg.task_status === "closed") {
        results.push({ number: num, status: "conflict", error: "task_is_done" });
        continue;
      }
      if (msg.task_assignee && msg.task_assignee !== userId) {
        results.push({ number: num, status: "conflict", error: "already_claimed_by_other" });
        continue;
      }
      await app.pg.query(
        "UPDATE messages SET task_status = 'in_progress', task_assignee = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3",
        [userId, ch.rows[0].id, num]
      );
      results.push({ number: num, status: "claimed" });
    }
    return { results };
  });

  app.post("/unclaim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, task_number } = req.body as any;
    const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [channel]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    await app.pg.query(
      "UPDATE messages SET task_assignee = NULL, task_status = 'todo', updated_at = now() WHERE channel_id = $1 AND task_number = $2",
      [ch.rows[0].id, task_number]
    );
    return { ok: true };
  });

  app.post("/update-status", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, number, status } = req.body as any;
    if (!STATUSES.includes(status)) return reply.status(400).send({ error: `invalid status: ${status}` });
    const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [channel]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    const result = await app.pg.query(
      "UPDATE messages SET task_status = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3 RETURNING *",
      [status, ch.rows[0].id, number]
    );
    return { ok: true, task: result.rows[0] };
  });
}
