import type { FastifyInstance } from "fastify";
import { broadcast } from "../ws/handler.js";
import { canAccessChannel } from "../lib/access.js";
import { isDmTarget, resolveDmTarget, dmOtherMembers, type Party } from "../lib/dm.js";

export async function messageRoutes(app: FastifyInstance) {
  // Get messages by channel
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, limit } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const userId = (req as any).user.sub;
    let channelId: string;
    if (isDmTarget(channel)) {
      const me: Party = { id: userId, type: "human", handle: (req as any).user.handle };
      const resolved = await resolveDmTarget(app, me, channel);
      if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
      channelId = resolved.channelId;
    } else {
      const name = channel.startsWith("#") ? channel.slice(1).split(":")[0] : channel;
      const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      channelId = String(ch.rows[0].id);
    }
    if (!(await canAccessChannel(app, channelId, userId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const result = await app.pg.query(
      "SELECT m.id, m.channel_id, m.server_id, m.sender_id, m.sender_type, COALESCE(u.display_name, u.handle, ag.display_name, ag.name, 'User') as \"senderName\", m.content, m.seq, m.thread_id, m.task_number, m.task_status, m.task_assignee, m.created_at as \"time\", m.edited_at as \"editedAt\", (SELECT COUNT(*) FROM messages WHERE thread_id = m.id)::int as \"replyCount\", (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mimeType', a.mime_type, 'sizeBytes', a.size_bytes, 'url', a.storage_url)), '[]') FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = m.id) as attachments FROM messages m LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id WHERE m.channel_id = $1 AND m.thread_id IS NULL ORDER BY m.seq DESC LIMIT $2",
      [channelId, Number(limit) || 50]
    );
    return { messages: result.rows.reverse(), hasMore: false };
  });

  // Get thread replies
  app.get("/thread/:messageId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const parent = await app.pg.query(
      "SELECT m.id, m.channel_id, m.content, m.sender_id, COALESCE(u.display_name, u.handle, 'User') as \"senderName\", m.created_at as \"time\" FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.id = $1",
      [messageId]
    );
    if (parent.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (!(await canAccessChannel(app, String(parent.rows[0].channel_id), (req as any).user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const replies = await app.pg.query(
      "SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.display_name, u.handle, 'User') as \"senderName\", m.content, m.seq, m.created_at as \"time\" FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.thread_id = $1 ORDER BY m.seq ASC",
      [messageId]
    );
    return { parent: parent.rows[0], replies: replies.rows };
  });

  app.post("/send", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, content, target, threadId, attachmentIds } = req.body as any;
    const ids: string[] = Array.isArray(attachmentIds) ? attachmentIds : [];
    if ((!content || !content.trim()) && ids.length === 0) {
      return reply.status(400).send({ error: "content or attachment required" });
    }
    if (!target) return reply.status(400).send({ error: "target required" });
    const userId = (req as any).user.sub;
    const senderHandle = (req as any).user?.handle || "unknown";
    let resolvedChannelId = channelId;
    let dmPeer: Party | undefined;
    const dm = isDmTarget(target);
    if (!resolvedChannelId) {
      if (dm) {
        const me: Party = { id: userId, type: "human", handle: senderHandle };
        const resolved = await resolveDmTarget(app, me, target);
        if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
        resolvedChannelId = resolved.channelId;
        dmPeer = resolved.peer;
      } else {
        const name = target.startsWith("#") ? target.slice(1).split(":")[0] : target;
        const ch = await app.pg.query("SELECT id, server_id FROM channels WHERE name = $1", [name]);
        if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
        resolvedChannelId = ch.rows[0].id;
      }
    }
    if (!(await canAccessChannel(app, resolvedChannelId, userId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const serverResult = await app.pg.query("SELECT server_id FROM channels WHERE id = $1", [resolvedChannelId]);
    const result = await app.pg.query(
      "INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id) VALUES ($1, $2, $3, 'human', $4, $5) RETURNING id, seq, created_at",
      [resolvedChannelId, serverResult.rows[0].server_id, userId, content || "", threadId || null]
    );
    const msg = result.rows[0];
    // @提及 agent 即邀请其加入该频道（DM 不适用：成员固定为双方）
    if (!dm && content && content.includes("@")) {
      const allAgents = await app.pg.query(
        "SELECT id, name FROM agents WHERE server_id = $1",
        [serverResult.rows[0].server_id]
      );
      for (const a of allAgents.rows as any[]) {
        if (content.includes("@" + a.name)) {
          await app.pg.query(
            "INSERT INTO channel_members (channel_id, member_id, member_type, role) VALUES ($1, $2, 'agent', 'member') ON CONFLICT DO NOTHING",
            [resolvedChannelId, a.id]
          );
        }
      }
    }
    let attachments: any[] = [];
    if (ids.length > 0) {
      for (const aid of ids) {
        await app.pg.query(
          "INSERT INTO message_attachments (message_id, attachment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [msg.id, aid]
        );
      }
      const att = await app.pg.query(
        "SELECT id, filename, mime_type as \"mimeType\", size_bytes as \"sizeBytes\", storage_url as url FROM attachments WHERE id = ANY($1)",
        [ids]
      );
      attachments = att.rows;
    }
    const senderName = (req as any).user?.display_name || (req as any).user?.handle || "unknown";
    // DM：浏览器侧用稳定的 dm:<uuid> 作为会话键；并附带 agent 接收方供 daemon「无需 @」唤醒
    let dmAgentRecipients: string[] | undefined;
    if (dm) {
      const others = await dmOtherMembers(app, resolvedChannelId, userId);
      dmAgentRecipients = others.agents.map((a) => a.handle);
    }
    const channelIdOut = dm ? "dm:" + resolvedChannelId : (target.startsWith("#") ? target : "#" + target);
    broadcast(resolvedChannelId, {
      type: "agent:deliver", seq: msg.seq,
      message: {
        id: msg.id, seq: msg.seq, channelId: channelIdOut,
        senderId: userId, senderName, senderHandle, senderType: "human",
        content: content || "", time: msg.created_at, threadId: threadId || null, attachments,
        ...(dm ? { dm: true, dmAgentRecipients, dmPeerHandle: dmPeer?.handle } : {}),
      },
    });
    const { inc } = await import("../lib/metrics.js");
    inc("messagesSent");
    if (dm) inc("dmSent");
    return { state: "sent", messageId: msg.id, messageSeq: msg.seq, attachments, channelId: dm ? "dm:" + resolvedChannelId : undefined };
  });

  app.get("/history", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, before, after, around, limit, threadId } = req.query as any;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const userId = (req as any).user.sub;
    let resolvedChannelId: string;
    if (isDmTarget(channel)) {
      const me: Party = { id: userId, type: "human", handle: (req as any).user.handle };
      const resolved = await resolveDmTarget(app, me, channel);
      if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
      resolvedChannelId = resolved.channelId;
    } else if (channel.startsWith("#")) {
      const name = channel.slice(1).split(":")[0];
      const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      resolvedChannelId = String(ch.rows[0].id);
    } else {
      resolvedChannelId = String(channel);
    }
    if (!(await canAccessChannel(app, resolvedChannelId, userId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    let query = "SELECT m.id, m.channel_id, m.server_id, m.sender_id, m.sender_type, COALESCE(u.display_name, u.handle, ag.display_name, ag.name, 'User') as \"senderName\", m.content, m.seq, m.thread_id, m.task_number, m.task_status, m.task_assignee, m.created_at as \"time\", m.edited_at as \"editedAt\", (SELECT COUNT(*) FROM messages WHERE thread_id = m.id)::int as \"replyCount\", (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mimeType', a.mime_type, 'sizeBytes', a.size_bytes, 'url', a.storage_url)), '[]') FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = m.id) as attachments FROM messages m LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id WHERE m.channel_id = $1 AND m.thread_id IS NULL";
    const params: (string | number)[] = [resolvedChannelId];
    let p = 2;
    if (threadId) { query += " AND m.thread_id = $" + p++; params.push(threadId); }
    if (before) { query += " AND seq < $" + p++; params.push(Number(before)); }
    if (after)  { query += " AND seq > $" + p++; params.push(Number(after)); }
    query += " ORDER BY seq DESC LIMIT $" + p;
    params.push(Number(limit) || 50);
    const result = await app.pg.query(query, params);
    return { messages: result.rows.reverse(), hasMore: result.rows.length >= (Number(limit) || 50) };
  });

  app.get("/search", { preHandler: [app.authenticate] }, async (req) => {
    const { q } = req.query as Record<string, string | undefined>;
    const userId = (req as any).user.sub;
    // 仅搜调用方可见的频道：公开频道，或其为成员的私有/DM 频道
    const result = await app.pg.query(
      `SELECT m.* FROM messages m
         JOIN channels c ON c.id = m.channel_id
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id::text = $3 AND cm.member_type = 'human'
        WHERE to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1)
          AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL)
        ORDER BY m.created_at DESC LIMIT $2`,
      [q || "", 20, userId]
    );
    return { results: result.rows, total: result.rows.length };
  });

  // 编辑消息（仅本人）
  app.put("/:messageId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const { content } = req.body as any;
    if (!content || !content.trim()) return reply.status(400).send({ error: "content required" });
    const userId = (req as any).user.sub;
    const m = await app.pg.query("SELECT sender_id, channel_id FROM messages WHERE id = $1", [messageId]);
    if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (String(m.rows[0].sender_id) !== String(userId)) {
      return reply.status(403).send({ error: "can only edit your own messages" });
    }
    const r = await app.pg.query(
      "UPDATE messages SET content = $1, edited_at = now() WHERE id = $2 RETURNING id, content, edited_at as \"editedAt\"",
      [content, messageId]
    );
    broadcast(String(m.rows[0].channel_id), { type: "message:update", message: { id: messageId, content, editedAt: r.rows[0].editedAt } } as any);
    return { message: r.rows[0] };
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
