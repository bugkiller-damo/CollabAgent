import type { FastifyInstance } from "fastify";

export async function messageRoutes(app: FastifyInstance) {
  app.post("/send", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, content, target, threadId, attachmentIds } = req.body as any;
    if (!content || !target) {
      return reply.status(400).send({ error: "content and target required" });
    }
    const userId = (req as any).user.sub;
    let resolvedChannelId = channelId;
    if (!resolvedChannelId) {
      const name = target.startsWith("#") ? target.slice(1).split(":")[0] : target;
      const ch = await app.pg.query("SELECT id, server_id FROM channels WHERE name = $1", [name]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      resolvedChannelId = ch.rows[0].id;
    }
    const serverResult = await app.pg.query("SELECT server_id FROM channels WHERE id = $1", [resolvedChannelId]);
    const result = await app.pg.query(
      `INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id)
       VALUES ($1, $2, $3, 'human', $4, $5) RETURNING id, seq, created_at`,
      [resolvedChannelId, serverResult.rows[0].server_id, userId, content, threadId || null]
    );
    const msg = result.rows[0];
    if (attachmentIds?.length) {
      for (const aid of attachmentIds) {
        await app.pg.query(
          "INSERT INTO message_attachments (message_id, attachment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [msg.id, aid]
        );
      }
    }
    return { state: "sent", messageId: msg.id, messageSeq: msg.seq };
  });

  app.get("/history", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, before, after, around, limit } = req.query as any;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    let resolvedChannelId: string;
    if (channel.startsWith("#")) {
      const name = channel.slice(1).split(":")[0];
      const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      resolvedChannelId = (ch.rows[0] as any).id;
    } else {
      resolvedChannelId = channel as string;
    }
    let query = "SELECT * FROM messages WHERE channel_id = $1";
    const params: any[] = [resolvedChannelId];
    let p = 2;
    if (before) { query += ` AND seq < $${p++}`; params.push(Number(before)); }
    if (after)  { query += ` AND seq > $${p++}`; params.push(Number(after)); }
    if (around) {
      const center = Number(around);
      query = `SELECT * FROM messages WHERE channel_id = $1 AND seq >= $2 AND seq <= $3`;
      params.push(center - 25, center + 25);
    }
    query += ` ORDER BY seq DESC LIMIT $${p}`;
    params.push(Number(limit) || 50);
    const result = await app.pg.query(query, params);
    return { messages: result.rows.reverse(), hasMore: result.rows.length >= (Number(limit) || 50) };
  });

  app.get("/search", { preHandler: [app.authenticate] }, async (req) => {
    const { q, channel, sender, sort, limit } = req.query as any;
    const result = await app.pg.query(
      `SELECT m.* FROM messages m
       WHERE to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1)
       ORDER BY ${sort === "recent" ? "m.created_at DESC" : "ts_rank(to_tsvector('simple', m.content), plainto_tsquery('simple', $1)) DESC"}
       LIMIT $2`,
      [q || "", Number(limit) || 20]
    );
    return { results: result.rows, total: result.rows.length };
  });

  app.post("/:messageId/reactions", { preHandler: [app.authenticate] }, async (req) => {
    const { messageId } = req.params as any;
    const { emoji } = req.body as any;
    await app.pg.query(
      "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [messageId, (req as any).user.sub, emoji]
    );
    return { ok: true };
  });

  app.delete("/:messageId/reactions", { preHandler: [app.authenticate] }, async (req) => {
    const { messageId } = req.params as any;
    const { emoji } = req.body as any;
    await app.pg.query(
      "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
      [messageId, (req as any).user.sub, emoji]
    );
    return { ok: true };
  });
}
