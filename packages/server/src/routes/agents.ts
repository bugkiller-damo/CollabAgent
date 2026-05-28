import type { FastifyInstance } from "fastify";
import { broadcast } from "../ws/handler.js";

export async function agentRoutes(app: FastifyInstance) {
  app.get("/:agentId/server", async (req) => {
    const result = await app.pg.query("SELECT * FROM servers LIMIT 1");
    const server = result.rows[0];
    const channels = await app.pg.query("SELECT c.* FROM channels c WHERE c.server_id = $1", [server.id]);
    const agents = await app.pg.query("SELECT * FROM agents WHERE server_id = $1", [server.id]);
    return { channels: channels.rows, agents: agents.rows, humans: [] };
  });

  app.post("/:agentId/send", async (req) => {
    const { target, content } = req.body as any;
    const { broadcast } = await import("../ws/handler.js");
    const agentId = (req.params as any).agentId;
    const channelName = target.startsWith("#") ? target.slice(1).split(":")[0] : target;
    const ch = await app.pg.query("SELECT id, server_id FROM channels WHERE name = $1", [channelName]);
    if (ch.rows.length === 0) return { error: "channel not found" };
    // Use a fixed UUID if agentId is not a valid UUID (e.g. "daemon-agent")
    const senderId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)
      ? agentId : "00000000-0000-0000-0000-00000000da01";
    const result = await app.pg.query(
      `INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content)
       VALUES ($1, $2, $3, 'agent', $4) RETURNING id, seq, created_at`,
      [ch.rows[0].id, ch.rows[0].server_id, senderId, content]
    );
    const msg = result.rows[0];
    broadcast(ch.rows[0].id, {
      type: "agent:deliver", seq: msg.seq,
      message: { id: msg.id, seq: msg.seq, channelId: target.startsWith("#") ? target : "#" + target, senderId: agentId, senderName: "Daemon", senderType: "agent", content, time: msg.created_at }
    });
    return { state: "sent", messageId: msg.id, messageSeq: msg.seq };
  });

  app.get("/:agentId/history", async (req) => {
    const { channel, limit } = req.query as any;
    const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [channel]);
    const result = await app.pg.query(
      "SELECT * FROM messages WHERE channel_id = $1 ORDER BY seq DESC LIMIT $2",
      [ch.rows[0]?.id, Number(limit) || 50]
    );
    return { messages: result.rows.reverse() };
  });
}
