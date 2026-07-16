import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { isDmTarget, resolveDmTarget, dmOtherMembers, type Party } from "../lib/dm.js";
import { getAgent, agentCanAccessChannel, resolveAgentChannelDbId } from "../lib/agent-helpers.js";
import { getStorage, isAllowedMimeType } from "../lib/storage.js";
import { broadcast } from "../ws/handler.js";
import { attachmentsJson } from "../lib/query-fragments.js";

export async function agentMessageRoutes(app: FastifyInstance) {
  app.post("/:agentId/send", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target, content, threadId, attachmentIds } = req.body as Record<string, unknown>;
    const agentId = (req.params as Record<string, string>).agentId;
    const attIds: string[] = Array.isArray(attachmentIds) ? (attachmentIds as string[]) : [];
    if (!target) return reply.status(400).send({ error: "target required" });
    const agent = await getAgent(app, agentId);
    const tstr = target as string;
    const dm = isDmTarget(tstr);
    let channelDbId: string, serverId: string;
    if (dm) {
      const me: Party = { id: agentId, type: "agent", handle: agent?.name || "agent" };
      const resolved = await resolveDmTarget(app, me, tstr);
      if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
      channelDbId = resolved.channelId;
      const sv = await app.pg.query<{ server_id: string }>("SELECT server_id FROM channels WHERE id = $1", [channelDbId]);
      serverId = sv.rows[0]?.server_id;
    } else {
      const ch = await app.pg.query("SELECT id, server_id FROM channels WHERE name = $1", [tstr.startsWith("#") ? tstr.slice(1).split(":")[0] : tstr]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      channelDbId = String(ch.rows[0].id);
      serverId = String(ch.rows[0].server_id);
    }
    if (!(await agentCanAccessChannel(app, channelDbId, agentId))) return reply.status(403).send({ error: "no access" });
    let resolvedThreadId: string | null = (threadId as string) || null;
    if (!resolvedThreadId) {
      const parts = tstr.split(":");
      const shortid = dm ? parts[2] : parts[1];
      if (shortid) {
        const parent = await app.pg.query<{ id: number }>("SELECT id FROM messages WHERE channel_id = $1 AND id::text LIKE $2 ORDER BY seq ASC LIMIT 1", [channelDbId, shortid + "%"]);
        if (parent.rows[0]) resolvedThreadId = String(parent.rows[0].id);
      }
    }
    const result = await app.pg.query("INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id) VALUES ($1, $2, $3, 'agent', $4, $5) RETURNING id, seq, created_at", [channelDbId, serverId, agentId, (content as string) || "", resolvedThreadId]);
    const msg = result.rows[0];
    let attachments: any[] = [];
    if (attIds.length > 0) {
      for (const aid of attIds) await app.pg.query("INSERT INTO message_attachments (message_id, attachment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [msg.id, aid]);
      const att = await app.pg.query("SELECT id, filename, mime_type as \"mimeType\", size_bytes as \"sizeBytes\", storage_url as url FROM attachments WHERE id = ANY($1)", [attIds]);
      attachments = att.rows;
    }
    let dmAgentRecipients: string[] | undefined;
    if (dm) { const others = await dmOtherMembers(app, channelDbId, agentId); dmAgentRecipients = others.agents.map((a) => a.handle); }
    broadcast(channelDbId, { type: "agent:deliver", seq: msg.seq, message: { id: msg.id, seq: msg.seq, channelId: dm ? "dm:" + channelDbId : "#" + (tstr.startsWith("#") ? tstr.slice(1).split(":")[0] : tstr), senderId: agentId, senderName: agent?.display_name || agent?.name || "Agent", senderHandle: agent?.name || "agent", senderType: "agent", content: (content as string) || "", time: msg.created_at, threadId: resolvedThreadId, attachments, ...(dm ? { dm: true, dmAgentRecipients } : {}) } });
    return { state: "sent", messageId: msg.id, messageSeq: msg.seq, attachments, channelId: dm ? "dm:" + channelDbId : undefined };
  });

  app.get("/:agentId/receive", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const agent = await getAgent(app, agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    if (agent.last_seen_seq === null || agent.last_seen_seq === undefined) {
      const maxR = await app.pg.query("SELECT COALESCE(MAX(seq), 0)::bigint as max FROM messages");
      await app.pg.query("UPDATE agents SET last_seen_seq = $1 WHERE id = $2", [maxR.rows[0].max, agentId]);
      return { messages: [] };
    }
    const result = await app.pg.query(`SELECT m.id, m.seq, c.name as channel, CASE WHEN c.type = 'dm' THEN 'dm:@' || (SELECT COALESCE(u2.handle, a2.name) FROM channel_members cm2 LEFT JOIN users u2 ON cm2.member_type='human' AND cm2.member_id=u2.id LEFT JOIN agents a2 ON cm2.member_type='agent' AND cm2.member_id=a2.id WHERE cm2.channel_id = c.id AND cm2.member_id::text <> $1::text LIMIT 1) ELSE '#' || c.name END as "channelId", (c.type = 'dm') as "isDm", COALESCE(u.display_name, u.handle, ag.display_name, ag.name, '?') as "senderName", m.sender_type as "senderType", m.content, m.created_at as time, ${attachmentsJson()} FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1 AND cm.member_type = 'agent' WHERE c.server_id = $2 AND c.archived = false AND m.thread_id IS NULL AND m.seq > $3 AND m.sender_id <> $1 AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL) ORDER BY m.seq DESC LIMIT 50`, [agentId, agent.server_id, agent.last_seen_seq]);
    const messages = result.rows.reverse();
    if (messages.length > 0) { const maxSeq = messages[messages.length - 1].seq; await app.pg.query("UPDATE agents SET last_seen_seq = $1 WHERE id = $2", [maxSeq, agentId]); }
    return { messages };
  });

  app.get("/:agentId/history", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, limit } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const channelDbId = await resolveAgentChannelDbId(app, agentId, channel);
    if (!channelDbId) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, channelDbId, agentId))) return reply.status(403).send({ error: "no access" });
    const result = await app.pg.query(`SELECT m.id, m.seq, CASE WHEN c.type = 'dm' THEN 'dm:@' || (SELECT COALESCE(u2.handle, a2.name) FROM channel_members cm2 LEFT JOIN users u2 ON cm2.member_type='human' AND cm2.member_id=u2.id LEFT JOIN agents a2 ON cm2.member_type='agent' AND cm2.member_id=a2.id WHERE cm2.channel_id = c.id AND cm2.member_id::text <> $3::text LIMIT 1) ELSE '#' || c.name END as "channelId", COALESCE(u.display_name, u.handle, ag.display_name, ag.name, '?') as "senderName", m.sender_type as "senderType", m.content, m.created_at as time, ${attachmentsJson()} FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id WHERE m.channel_id = $1 AND m.thread_id IS NULL ORDER BY m.seq DESC LIMIT $2`, [channelDbId, Number(limit) || 50, agentId]);
    return { messages: result.rows.reverse() };
  });

  app.get("/:agentId/server", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const agent = await getAgent(app, agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const [channels, agents, humans] = await Promise.all([
      app.pg.query(`SELECT c.id, c.name, c.description, c.type, (cm.member_id IS NOT NULL) as joined FROM channels c LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1 AND cm.member_type = 'agent' WHERE c.server_id = $2 AND c.archived = false AND c.type <> 'dm' AND (c.type <> 'private' OR cm.member_id IS NOT NULL) ORDER BY c.created_at`, [agentId, agent.server_id]),
      app.pg.query("SELECT id, name, display_name, avatar_url FROM agents WHERE server_id = $1", [agent.server_id]),
      app.pg.query("SELECT id, handle, display_name FROM users ORDER BY handle"),
    ]);
    return { serverId: agent.server_id, channels: channels.rows, agents: agents.rows, humans: humans.rows };
  });

  app.get("/:agentId/channel-members", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const channelDbId = await resolveAgentChannelDbId(app, agentId, channel);
    if (!channelDbId) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, channelDbId, agentId))) return reply.status(403).send({ error: "no access" });
    const result = await app.pg.query(`SELECT cm.member_id, cm.member_type, cm.role, COALESCE(u.handle, a.name) as handle, COALESCE(u.display_name, a.display_name) as display_name FROM channel_members cm LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id WHERE cm.channel_id = $1`, [channelDbId]);
    return { members: result.rows };
  });

  app.post("/:agentId/upload", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: "file required" });
    let buf: Buffer;
    try { buf = await data.toBuffer(); } catch { return reply.status(413).send({ error: "file too large (max 10MB)" }); }
    if (data.file?.truncated) return reply.status(413).send({ error: "file too large (max 10MB)" });
    if (!isAllowedMimeType(data.mimetype)) return reply.status(415).send({ error: `file type ${data.mimetype} not allowed` });
    const storage = getStorage();
    const storageKey = randomUUID() + "/" + (data.filename || "file");
    await storage.save(storageKey, buf);
    const r = await app.pg.query<{ id: number; filename: string; mime_type: string; size_bytes: number; storage_url: string }>("INSERT INTO attachments (uploader_id, uploader_type, filename, mime_type, size_bytes, storage_key, storage_url) VALUES ($1, 'agent', $2, $3, $4, $5, $6) RETURNING id, filename, mime_type, size_bytes, storage_url", [agentId, data.filename || "file", data.mimetype, buf.length, storageKey, storage.publicUrl(storageKey)]);
    const row = r.rows[0];
    return { attachmentId: row.id, filename: row.filename, mimeType: row.mime_type, sizeBytes: row.size_bytes, url: row.storage_url };
  });

  app.post("/:agentId/messages/:messageId/reactions", { preHandler: [app.authenticate] }, async (req) => {
    const agentId = (req.params as Record<string, string>).agentId, messageId = (req.params as Record<string, string>).messageId, { emoji } = req.body as { emoji?: string };
    await app.pg.query("INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [messageId, agentId, emoji]);
    return { ok: true };
  });
  app.delete("/:agentId/messages/:messageId/reactions", { preHandler: [app.authenticate] }, async (req) => {
    const agentId = (req.params as Record<string, string>).agentId, messageId = (req.params as Record<string, string>).messageId, { emoji } = req.body as { emoji?: string };
    await app.pg.query("DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3", [messageId, agentId, emoji]);
    return { ok: true };
  });

  app.get("/:agentId/search", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { q, channel, limit } = req.query as Record<string, string>;
    if (!q) return reply.status(400).send({ error: "query required" });
    const agent = await getAgent(app, agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const params: any[] = [q, agent.server_id, agentId];
    let chFilter = "";
    if (channel) {
      const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [channel.startsWith("#") ? channel.slice(1) : channel]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" }); params.push(ch.rows[0].id); chFilter = ` AND m.channel_id = $${params.length}`;
    }
    params.push(Number(limit) || 20);
    const result = await app.pg.query(`SELECT m.id, m.content, m.seq, '#' || c.name as "channelId", m.created_at as time FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $3 AND cm.member_type = 'agent' WHERE c.server_id = $2 AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL) AND to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1)${chFilter} ORDER BY m.created_at DESC LIMIT $${params.length}`, params);
    return { results: result.rows, total: result.rows.length };
  });
}
