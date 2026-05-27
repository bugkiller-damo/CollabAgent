import type { FastifyInstance } from "fastify";

export async function reminderRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req) => {
    const { status } = req.query as any;
    const userId = (req as any).user.sub;
    let query = "SELECT * FROM reminders WHERE owner_id = $1";
    const params: any[] = [userId];
    if (status) {
      params.push(status.split(","));
      query += " AND status = ANY($2)";
    } else {
      query += " AND status IN ('scheduled','fired')";
    }
    query += " ORDER BY fire_at ASC";
    const result = await app.pg.query(query, params);
    return { reminders: result.rows };
  });

  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { title, delaySeconds, fireAt, repeat, channel, msgId } = req.body as any;
    if (!title) return reply.status(400).send({ error: "title required" });
    let fireTime: Date;
    if (delaySeconds) {
      fireTime = new Date(Date.now() + Number(delaySeconds) * 1000);
    } else if (fireAt) {
      fireTime = new Date(fireAt);
    } else {
      return reply.status(400).send({ error: "delaySeconds or fireAt required" });
    }
    const result = await app.pg.query(
      `INSERT INTO reminders (owner_id, title, fire_at, repeat_rule, channel_ref, anchor_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [(req as any).user.sub, title, fireTime, repeat || null, channel || null, msgId || null]
    );
    return { reminder: result.rows[0] };
  });

  app.get("/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const result = await app.pg.query("SELECT * FROM reminders WHERE id = $1", [(req.params as any).id]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "not found" });
    return { reminder: result.rows[0] };
  });

  app.patch("/:id", { preHandler: [app.authenticate] }, async (req) => {
    const { title, fireAt, repeat } = req.body as any;
    const { id } = req.params as any;
    const result = await app.pg.query(
      `UPDATE reminders SET title = COALESCE($2, title), fire_at = COALESCE($3, fire_at),
       repeat_rule = COALESCE($4, repeat_rule), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, title || null, fireAt ? new Date(fireAt) : null, repeat || null]
    );
    return { reminder: result.rows[0] };
  });

  app.post("/:id/snooze", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as any;
    const { duration } = req.body as any;
    const match = /^(\d+)(m|h|d)$/.exec(duration || "");
    if (!match) return reply.status(400).send({ error: "duration format: 30m, 2h, 1d" });
    const units: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
    const ms = Number(match[1]) * units[match[2]];
    const result = await app.pg.query(
      "UPDATE reminders SET fire_at = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [new Date(Date.now() + ms), id]
    );
    await app.pg.query(
      "INSERT INTO reminder_events (reminder_id, event_type, detail) VALUES ($1, $2, $3)",
      [id, "snoozed", JSON.stringify({ duration, newFireAt: result.rows[0].fire_at })]
    );
    return { reminder: result.rows[0] };
  });

  app.delete("/:id", { preHandler: [app.authenticate] }, async (req) => {
    await app.pg.query("UPDATE reminders SET status = 'canceled', updated_at = now() WHERE id = $1", [(req.params as any).id]);
    return { ok: true };
  });

  app.get("/:id/log", { preHandler: [app.authenticate] }, async (req) => {
    const result = await app.pg.query(
      "SELECT * FROM reminder_events WHERE reminder_id = $1 ORDER BY created_at ASC",
      [(req.params as any).id]
    );
    return { events: result.rows };
  });
}
