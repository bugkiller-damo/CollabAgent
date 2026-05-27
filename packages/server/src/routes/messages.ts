import type { FastifyInstance } from "fastify";
import { broadcast } from "../ws/handler.js";

export async function messageRoutes(app: FastifyInstance) {
  // Public: get messages by channel (dev mode, no auth)
  app.get("/", async (req, reply) => {
    const { channel, limit } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const name = channel.startsWith("#") ? channel.slice(1).split(":")[0] : channel;
    const ch = await app.pg.query(
      "SELECT id FROM channels WHERE name = $1", [name]
    );
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    const result = await app.pg.query(
      "SELECT m.id, m.channel_id, m.server_id, m.sender_id, m.sender_type, COALESCE(u.display_name, u.handle, 'User') as \"senderName\", m.content, m.seq, m.thread_id, m.task_number, m.task_status, m.task_assignee, m.created_at as \"time\" FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.channel_id = $1 AND m.thread_id IS NULL ORDER BY m.seq DESC LIMIT $2",
      [ch.rows[0].id, Number(limit) || 50]
    );
    return { messages: result.rows.reverse(), hasMore: false };
  });

  // Get thread replies
  app.get("/thread/:messageId", async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const parent = await app.pg.query(
      "SELECT id, channel_id, content, sender_id, sender_type as \"senderName\", created_at as \"time\" FROM messages WHERE id = $1",
      [messageId]
    );
    if (parent.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    const replies = await app.pg.query(
      "SELECT id, channel_id, sender_id, sender_type as \"senderName\", content, seq, created_at as \"time\" FROM messages WHERE thread_id = $1 ORDER BY seq ASC",
      [messageId]
    );
    return { parent: parent.rows[0], replies: replies.rows };
  });

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
      "INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id) VALUES ($1, $2, $3, 'human', $4, $5) RETURNING id, seq, created_at",
      [resolvedChannelId, serverResult.rows[0].server_id, userId, content, threadId || null]
    );
    const msg = result.rows[0];
    const senderName = (req as any).user?.handle || "unknown";
    const channelName = target.startsWith("#") ? target : "#" + target;
    broadcast(resolvedChannelId, { type: "agent:deliver", seq: msg.seq, message: { id: msg.id, seq: msg.seq, channelId: channelName, senderId: userId, senderName, senderType: "human", content, time: msg.created_at }});
    return { state: "sent", messageId: msg.id, messageSeq: msg.seq };
  });

  app.get("/history", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, before, after, around, limit, threadId } = req.query as any;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    let resolvedChannelId: string;
    if (channel.startsWith("#")) {
      const name = channel.slice(1).split(":")[0];
      const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      resolvedChannelId = ch.rows[0].id;
    } else {
      resolvedChannelId = channel;
    }
    let query = "SELECT m.id, m.channel_id, m.server_id, m.sender_id, m.sender_type, COALESCE(u.display_name, u.handle, 'User') as \"senderName\", m.content, m.seq, m.thread_id, m.task_number, m.task_status, m.task_assignee, m.created_at as \"time\" FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.channel_id = $1 AND m.thread_id IS NULL";
    if (threadId) { query += " AND m.thread_id = $" + p; p++; params.push(threadId); }
    const params: (string | number)[] = [resolvedChannelId];
    let p = 2;
    if (before) { query += " AND seq < $" + p++; params.push(Number(before)); }
    if (after)  { query += " AND seq > $" + p++; params.push(Number(after)); }
    query += " ORDER BY seq DESC LIMIT $" + p;
    params.push(Number(limit) || 50);
    const result = await app.pg.query(query, params);
    return { messages: result.rows.reverse(), hasMore: result.rows.length >= (Number(limit) || 50) };
  });

  app.get("/search", { preHandler: [app.authenticate] }, async (req) => {
    const { q } = req.query as Record<string, string | undefined>;
    const result = await app.pg.query(
      "SELECT m.* FROM messages m WHERE to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1) ORDER BY m.created_at DESC LIMIT $2",
      [q || "", 20]
    );
    return { results: result.rows, total: result.rows.length };
  });

  app.post("/:messageId/reactions", { preHandler: [app.authenticate] }, async (req) => {
    const { messageId } = req.params as Record<string, string>;
    const { emoji } = req.body as Record<string, unknown>;
    await app.pg.query(
      "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [messageId, (req as any).user.sub, emoji as string]
    );
    return { ok: true };
  });
}
