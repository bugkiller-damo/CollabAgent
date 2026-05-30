import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { daemonClients, broadcastToDaemons } from "../ws/handler.js";
import { initialFireAt, parseDurationToMs, reminderToDto } from "../lib/reminders.js";
import { getStorage } from "../lib/storage.js";
import { isDmTarget, resolveDmTarget, dmOtherMembers, dmPeerHandleFor, type Party } from "../lib/dm.js";

export async function agentRoutes(app: FastifyInstance) {
  // 解析 agent；找不到返回 null
  async function getAgent(agentId: string): Promise<any | null> {
    const r = await app.pg.query("SELECT id, name, display_name, server_id, last_seen_seq FROM agents WHERE id = $1", [agentId]);
    return r.rows[0] || null;
  }

  // agent 访问控制：公开频道放行；私有频道需 agent 是成员
  async function agentCanAccessChannel(channelId: any, agentId: any): Promise<boolean> {
    const r = await app.pg.query("SELECT type FROM channels WHERE id = $1", [channelId]);
    const type = (r.rows[0] as any)?.type;
    if (type == null) return false;
    if (type !== "private" && type !== "dm") return true;
    const m = await app.pg.query(
      "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent'",
      [channelId, agentId]
    );
    return m.rows.length > 0;
  }
  // List all agents with online status
  app.get("/", async () => {
    const result = await app.pg.query(
      "SELECT id, name, display_name, description, status, runtime, model, created_at FROM agents ORDER BY created_at DESC"
    );
    const agents = (result.rows as any[]).map((a) => ({
      ...a,
      isOnline: daemonClients.has(a.id),
    }));
    return { agents };
  });

  // List agents in a channel
  app.get("/channel/:channelId", async (req) => {
    const { channelId } = req.params as Record<string, string>;
    const result = await app.pg.query(
      "SELECT a.id, a.name, a.display_name, a.description, a.status, a.runtime, a.model, cm.role FROM agents a JOIN channel_members cm ON cm.member_id = a.id AND cm.member_type = 'agent' WHERE cm.channel_id = $1",
      [channelId]
    );
    const agents = (result.rows as any[]).map((a) => ({
      ...a,
      isOnline: daemonClients.has(a.id),
    }));
    return { agents };
  });

  // Create agent (via action card approval)
  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { name, displayName, description, runtime, model, serverId } = req.body as Record<string, unknown>;
    if (!name || !serverId) return reply.status(400).send({ error: "name and serverId required" });
    const userId = (req as any).user.sub;
    const result = await app.pg.query(
      "INSERT INTO agents (user_id, server_id, name, display_name, description, runtime, model) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [userId, serverId as string, name as string, (displayName || name) as string, description || "", runtime || "claude", model || "sonnet"]
    );
    const agent = result.rows[0];
    // Notify all daemons to spawn this agent
    broadcastToDaemons({
      type: "agent:start",
      agentId: agent.id,
      config: {
        name: agent.name,
        displayName: agent.display_name,
        description: agent.description,
        runtime: agent.runtime,
        model: agent.model,
      },
    });
    return { agent };
  });

  // Agent send message (requires recognized token; agent must be real)
  app.post("/:agentId/send", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target, content, threadId, attachmentIds } = req.body as Record<string, unknown>;
    const agentId = (req.params as any).agentId;
    const attIds: string[] = Array.isArray(attachmentIds) ? (attachmentIds as string[]) : [];
    if ((!content || !(content as string).trim()) && attIds.length === 0) {
      return reply.status(400).send({ error: "content or attachment required" });
    }
    if (!target) return reply.status(400).send({ error: "target required" });
    // 已通过 authenticate 鉴权；agent 不存在时降级用通用名（兼容旧 daemon），不阻断
    const agent = await getAgent(agentId);
    const tstr = target as string;
    const dm = isDmTarget(tstr);
    let channelDbId: string;
    let serverId: string;
    let channelName: string; // 仅用于非 DM 的广播 channelId
    if (dm) {
      const me: Party = { id: agentId, type: "agent", handle: agent?.name || "agent" };
      const resolved = await resolveDmTarget(app, me, tstr);
      if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
      channelDbId = resolved.channelId;
      const sv = await app.pg.query("SELECT server_id FROM channels WHERE id = $1", [channelDbId]);
      serverId = (sv.rows[0] as any)?.server_id;
      channelName = "";
    } else {
      channelName = tstr.startsWith("#") ? tstr.slice(1).split(":")[0] : tstr;
      const ch = await app.pg.query("SELECT id, server_id FROM channels WHERE name = $1", [channelName]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      channelDbId = String(ch.rows[0].id);
      serverId = String(ch.rows[0].server_id);
    }
    // 私有频道 / DM：agent 必须是成员
    if (!(await agentCanAccessChannel(channelDbId, agentId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    // 线程回复：target 形如 "#channel:shortid" 或 "dm:@x:shortid" 时，按 shortid 解析父消息作为 thread_id
    let resolvedThreadId: string | null = (threadId as string) || null;
    if (!resolvedThreadId) {
      const parts = tstr.split(":");
      // 非 DM：#channel:shortid → parts[1]；DM：dm:@handle:shortid → parts[2]
      const shortid = dm ? parts[2] : parts[1];
      if (shortid) {
        const parent = await app.pg.query(
          "SELECT id FROM messages WHERE channel_id = $1 AND id::text LIKE $2 ORDER BY seq ASC LIMIT 1",
          [channelDbId, shortid + "%"]
        );
        if (parent.rows[0]) resolvedThreadId = String((parent.rows[0] as any).id);
      }
    }
    const result = await app.pg.query(
      "INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id) VALUES ($1, $2, $3, 'agent', $4, $5) RETURNING id, seq, created_at",
      [channelDbId, serverId, agentId, (content as string) || "", resolvedThreadId]
    );
    const msg = result.rows[0];
    // 关联附件
    let attachments: any[] = [];
    if (attIds.length > 0) {
      for (const aid of attIds) {
        await app.pg.query(
          "INSERT INTO message_attachments (message_id, attachment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [msg.id, aid]
        );
      }
      const att = await app.pg.query(
        "SELECT id, filename, mime_type as \"mimeType\", size_bytes as \"sizeBytes\", storage_url as url FROM attachments WHERE id = ANY($1)",
        [attIds]
      );
      attachments = att.rows;
    }
    const { broadcast } = await import("../ws/handler.js");
    // DM：浏览器侧用稳定 dm:<uuid> 键；并带上「另一个 agent 接收方」供 daemon 唤醒（agent↔agent DM）
    let dmAgentRecipients: string[] | undefined;
    if (dm) {
      const others = await dmOtherMembers(app, channelDbId, agentId);
      dmAgentRecipients = others.agents.map((a) => a.handle);
    }
    const channelIdOut = dm ? "dm:" + channelDbId : "#" + channelName;
    broadcast(channelDbId, {
      type: "agent:deliver",
      seq: msg.seq,
      message: {
        id: msg.id, seq: msg.seq,
        channelId: channelIdOut, senderId: agentId,
        senderName: agent?.display_name || agent?.name || "Agent",
        senderHandle: agent?.name || "agent",
        senderType: "agent",
        content: (content as string) || "",
        time: msg.created_at,
        threadId: resolvedThreadId,
        attachments,
        ...(dm ? { dm: true, dmAgentRecipients } : {}),
      },
    });
    return { state: "sent", messageId: msg.id, messageSeq: msg.seq, attachments, channelId: dm ? "dm:" + channelDbId : undefined };
  });

  // --- Phase 1: agent listen/read endpoints ---

  // 非阻塞拉取新消息（基于 last_seen_seq 游标）
  app.get("/:agentId/receive", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const agent = await getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });

    // 首次检查：从“当前最新”开始监听，不回灌历史
    if (agent.last_seen_seq === null || agent.last_seen_seq === undefined) {
      const maxR = await app.pg.query("SELECT COALESCE(MAX(seq), 0)::bigint as max FROM messages");
      await app.pg.query("UPDATE agents SET last_seen_seq = $1 WHERE id = $2", [maxR.rows[0].max, agentId]);
      return { messages: [] };
    }

    const result = await app.pg.query(
      `SELECT m.id, m.seq, c.name as channel,
              CASE WHEN c.type = 'dm'
                   THEN 'dm:@' || (SELECT COALESCE(u2.handle, a2.name)
                                     FROM channel_members cm2
                                     LEFT JOIN users u2 ON cm2.member_type='human' AND cm2.member_id=u2.id
                                     LEFT JOIN agents a2 ON cm2.member_type='agent' AND cm2.member_id=a2.id
                                    WHERE cm2.channel_id = c.id AND cm2.member_id::text <> $1::text LIMIT 1)
                   ELSE '#' || c.name END as "channelId",
              (c.type = 'dm') as "isDm",
              COALESCE(u.display_name, u.handle, ag.display_name, ag.name, '?') as "senderName",
              m.sender_type as "senderType", m.content, m.created_at as time,
              (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mimeType', a.mime_type, 'sizeBytes', a.size_bytes, 'url', a.storage_url)), '[]') FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = m.id) as attachments
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN users u ON m.sender_id = u.id
       LEFT JOIN agents ag ON m.sender_id = ag.id
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1 AND cm.member_type = 'agent'
       WHERE c.server_id = $2 AND c.archived = false AND m.thread_id IS NULL
         AND m.seq > $3 AND m.sender_id <> $1
         AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL)
       ORDER BY m.seq DESC LIMIT 50`,
      [agentId, agent.server_id, agent.last_seen_seq]
    );
    const messages = result.rows.reverse();
    if (messages.length > 0) {
      const maxSeq = messages[messages.length - 1].seq;
      await app.pg.query("UPDATE agents SET last_seen_seq = $1 WHERE id = $2", [maxSeq, agentId]);
    }
    return { messages };
  });

  // agent 侧统一解析频道参数（#频道名 或 dm:@handle / dm:<uuid>）→ 频道 db id
  async function resolveAgentChannelDbId(agentId: string, channelArg: string): Promise<string | null> {
    if (isDmTarget(channelArg)) {
      const ag = await getAgent(agentId);
      const me: Party = { id: agentId, type: "agent", handle: ag?.name || "agent" };
      const r = await resolveDmTarget(app, me, channelArg);
      return r?.channelId ?? null;
    }
    const name = channelArg.startsWith("#") ? channelArg.slice(1).split(":")[0] : channelArg;
    const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
    return (ch.rows[0] as any)?.id ?? null;
  }

  // 读取频道历史
  app.get("/:agentId/history", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { channel, limit } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const channelDbId = await resolveAgentChannelDbId(agentId, channel);
    if (!channelDbId) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(channelDbId, agentId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const result = await app.pg.query(
      `SELECT m.id, m.seq,
              CASE WHEN c.type = 'dm'
                   THEN 'dm:@' || (SELECT COALESCE(u2.handle, a2.name)
                                     FROM channel_members cm2
                                     LEFT JOIN users u2 ON cm2.member_type='human' AND cm2.member_id=u2.id
                                     LEFT JOIN agents a2 ON cm2.member_type='agent' AND cm2.member_id=a2.id
                                    WHERE cm2.channel_id = c.id AND cm2.member_id::text <> $3::text LIMIT 1)
                   ELSE '#' || c.name END as "channelId",
              COALESCE(u.display_name, u.handle, ag.display_name, ag.name, '?') as "senderName",
              m.sender_type as "senderType", m.content, m.created_at as time,
              (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mimeType', a.mime_type, 'sizeBytes', a.size_bytes, 'url', a.storage_url)), '[]') FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = m.id) as attachments
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN users u ON m.sender_id = u.id
       LEFT JOIN agents ag ON m.sender_id = ag.id
       WHERE m.channel_id = $1 AND m.thread_id IS NULL
       ORDER BY m.seq DESC LIMIT $2`,
      [channelDbId, Number(limit) || 50, agentId]
    );
    return { messages: result.rows.reverse() };
  });

  // 服务器信息（频道/agents/humans）
  app.get("/:agentId/server", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const agent = await getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const [channels, agents, humans] = await Promise.all([
      app.pg.query(
        `SELECT c.id, c.name, c.description, c.type, (cm.member_id IS NOT NULL) as joined
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1 AND cm.member_type = 'agent'
         WHERE c.server_id = $2 AND c.archived = false AND c.type <> 'dm'
           AND (c.type <> 'private' OR cm.member_id IS NOT NULL)
         ORDER BY c.created_at`,
        [agentId, agent.server_id]
      ),
      app.pg.query("SELECT id, name, display_name FROM agents WHERE server_id = $1", [agent.server_id]),
      app.pg.query("SELECT id, handle, display_name FROM users ORDER BY handle"),
    ]);
    return { serverId: agent.server_id, channels: channels.rows, agents: agents.rows, humans: humans.rows };
  });

  // 频道成员
  app.get("/:agentId/channel-members", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { channel } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const channelDbId = await resolveAgentChannelDbId(agentId, channel);
    if (!channelDbId) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(channelDbId, agentId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const result = await app.pg.query(
      `SELECT cm.member_id, cm.member_type, cm.role,
              COALESCE(u.handle, a.name) as handle,
              COALESCE(u.display_name, a.display_name) as display_name
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
       WHERE cm.channel_id = $1`,
      [channelDbId]
    );
    return { members: result.rows };
  });

  // 上传附件（agent 身份）
  app.post("/:agentId/upload", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const data = await (req as any).file();
    if (!data) return reply.status(400).send({ error: "file required" });
    let buf: Buffer;
    try { buf = await data.toBuffer(); } catch { return reply.status(413).send({ error: "file too large (max 10MB)" }); }
    if ((data as any).file?.truncated) return reply.status(413).send({ error: "file too large (max 10MB)" });
    const storage = getStorage();
    const filename = data.filename || "file";
    const storageKey = randomUUID() + "/" + filename;
    await storage.save(storageKey, buf);
    const url = storage.publicUrl(storageKey);
    const r = await app.pg.query(
      "INSERT INTO attachments (uploader_id, uploader_type, filename, mime_type, size_bytes, storage_key, storage_url) VALUES ($1, 'agent', $2, $3, $4, $5, $6) RETURNING id, filename, mime_type, size_bytes, storage_url",
      [agentId, filename, data.mimetype, buf.length, storageKey, url]
    );
    const row = r.rows[0] as any;
    return { attachmentId: row.id, filename: row.filename, mimeType: row.mime_type, sizeBytes: row.size_bytes, url: row.storage_url };
  });

  // --- Phase 3: agent tasks / reactions / search / profile ---

  const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"];

  async function resolveChannelByName(channel: string): Promise<any | null> {
    const name = channel.startsWith("#") ? channel.slice(1).split(":")[0] : channel;
    const r = await app.pg.query("SELECT id, server_id FROM channels WHERE name = $1", [name]);
    return r.rows[0] || null;
  }

  // 任务列表
  app.get("/:agentId/tasks", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { channel, status } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    let query = "SELECT id, content, task_number, task_status, task_assignee, created_at FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL";
    const params: any[] = [ch.id];
    if (status && status !== "all") { params.push(status); query += ` AND task_status = $${params.length}`; }
    query += " ORDER BY task_number ASC";
    const result = await app.pg.query(query, params);
    return { tasks: result.rows };
  });

  // 创建任务（以 agent 身份）
  app.post("/:agentId/tasks", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { channel, tasks } = req.body as any;
    if (!channel || !tasks?.length) return reply.status(400).send({ error: "channel and tasks required" });
    const ch = await resolveChannelByName(channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const maxNum = await app.pg.query(
      "SELECT COALESCE(MAX(task_number), 0) as n FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL",
      [ch.id]
    );
    let next = Number((maxNum.rows[0] as any).n);
    const created: any[] = [];
    for (const t of tasks) {
      next++;
      const r = await app.pg.query(
        `INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, task_number, task_status)
         VALUES ($1, $2, $3, 'agent', $4, $5, 'todo') RETURNING id, task_number, content`,
        [ch.id, ch.server_id, agentId, t.title, next]
      );
      created.push(r.rows[0]);
    }
    return { tasks: created };
  });

  // 认领任务（assignee = 该 agent）
  app.post("/:agentId/tasks/claim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { channel, task_numbers, message_ids } = req.body as any;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const results: any[] = [];
    const nums: number[] = [...(task_numbers || [])];
    // message_ids → task_numbers
    for (const mid of (message_ids || [])) {
      const r = await app.pg.query("SELECT task_number FROM messages WHERE id = $1 AND channel_id = $2", [mid, ch.id]);
      if (r.rows[0]?.task_number != null) nums.push(Number(r.rows[0].task_number));
    }
    for (const num of nums) {
      const existing = await app.pg.query("SELECT * FROM messages WHERE channel_id = $1 AND task_number = $2", [ch.id, num]);
      if (existing.rows.length === 0) { results.push({ number: num, status: "conflict", error: "not_found" }); continue; }
      const m = existing.rows[0] as any;
      if (m.task_status === "done" || m.task_status === "closed") { results.push({ number: num, status: "conflict", error: "task_is_done" }); continue; }
      if (m.task_assignee && String(m.task_assignee) !== String(agentId)) { results.push({ number: num, status: "conflict", error: "already_claimed_by_other" }); continue; }
      await app.pg.query(
        "UPDATE messages SET task_status = 'in_progress', task_assignee = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3",
        [agentId, ch.id, num]
      );
      results.push({ number: num, status: "claimed" });
    }
    return { results };
  });

  // 取消认领
  app.post("/:agentId/tasks/unclaim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { channel, task_number } = req.body as any;
    const ch = await resolveChannelByName(channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    await app.pg.query(
      "UPDATE messages SET task_assignee = NULL, task_status = 'todo', updated_at = now() WHERE channel_id = $1 AND task_number = $2",
      [ch.id, task_number]
    );
    return { ok: true };
  });

  // 更新任务状态
  app.post("/:agentId/tasks/update-status", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { channel, number, status } = req.body as any;
    if (!TASK_STATUSES.includes(status)) return reply.status(400).send({ error: `invalid status: ${status}` });
    const ch = await resolveChannelByName(channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const r = await app.pg.query(
      "UPDATE messages SET task_status = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3 RETURNING id, task_number, task_status",
      [status, ch.id, number]
    );
    return { ok: true, task: r.rows[0] };
  });

  // 表情反应（添加/移除）
  app.post("/:agentId/messages/:messageId/reactions", { preHandler: [app.authenticate] }, async (req) => {
    const agentId = (req.params as any).agentId;
    const messageId = (req.params as any).messageId;
    const { emoji } = req.body as any;
    await app.pg.query(
      "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [messageId, agentId, emoji]
    );
    return { ok: true };
  });

  app.delete("/:agentId/messages/:messageId/reactions", { preHandler: [app.authenticate] }, async (req) => {
    const agentId = (req.params as any).agentId;
    const messageId = (req.params as any).messageId;
    const { emoji } = req.body as any;
    await app.pg.query(
      "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
      [messageId, agentId, emoji]
    );
    return { ok: true };
  });

  // 搜索消息（限 agent 可见频道）
  app.get("/:agentId/search", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { q, channel, limit } = req.query as Record<string, string>;
    if (!q) return reply.status(400).send({ error: "query required" });
    const agent = await getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const params: any[] = [q, agent.server_id, agentId];
    let chFilter = "";
    if (channel) {
      const ch = await resolveChannelByName(channel);
      if (!ch) return reply.status(404).send({ error: "channel not found" });
      params.push(ch.id);
      chFilter = ` AND m.channel_id = $${params.length}`;
    }
    params.push(Number(limit) || 20);
    const result = await app.pg.query(
      `SELECT m.id, m.content, m.seq, '#' || c.name as "channelId", m.created_at as time
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $3 AND cm.member_type = 'agent'
       WHERE c.server_id = $2 AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL)
         AND to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1)${chFilter}
       ORDER BY m.created_at DESC LIMIT $${params.length}`,
      params
    );
    return { results: result.rows, total: result.rows.length };
  });

  // 查看资料（自己或他人）
  app.get("/:agentId/profile", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { target } = req.query as Record<string, string>;
    if (target) {
      const handle = target.replace(/^@/, "");
      const u = await app.pg.query("SELECT handle, display_name, description FROM users WHERE handle = $1", [handle]);
      if (u.rows.length) return { type: "human", ...u.rows[0] };
      const a = await app.pg.query("SELECT name as handle, display_name, description FROM agents WHERE name = $1", [handle]);
      if (a.rows.length) return { type: "agent", ...a.rows[0] };
      return reply.status(404).send({ error: "profile not found" });
    }
    const self = await app.pg.query("SELECT name as handle, display_name, description FROM agents WHERE id = $1", [agentId]);
    if (self.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    return { type: "agent", ...self.rows[0] };
  });

  // 更新自己的资料
  app.post("/:agentId/profile", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const { displayName, description } = req.body as any;
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (displayName !== undefined) { sets.push(`display_name = $${p++}`); params.push(displayName); }
    if (description !== undefined) { sets.push(`description = $${p++}`); params.push(description); }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    const r = await app.pg.query(
      `UPDATE agents SET ${sets.join(", ")} WHERE id = $${p} RETURNING name as handle, display_name, description`,
      params
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    return { type: "agent", ...r.rows[0] };
  });

  // --- Phase 4: agent reminders（提醒/自我唤醒）---

  // 定提醒
  app.post("/:agentId/reminders", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const body = (req.body as any) || {};
    if (!body.title) return reply.status(400).send({ error: "title required" });
    const fireAt = initialFireAt(body);
    if (!fireAt) return reply.status(400).send({ error: "need fireAt, delaySeconds, or repeat" });
    const r = await app.pg.query(
      `INSERT INTO reminders (owner_id, title, fire_at, repeat_rule, channel_ref, status)
       VALUES ($1, $2, $3, $4, $5, 'scheduled') RETURNING *`,
      [agentId, body.title, fireAt.toISOString(), body.repeat || null, body.channel || null]
    );
    return { reminder: reminderToDto(r.rows[0]) };
  });

  // 列出提醒
  app.get("/:agentId/reminders", { preHandler: [app.authenticate] }, async (req) => {
    const agentId = (req.params as any).agentId;
    const { status } = req.query as Record<string, string>;
    const all = status === "all";
    const r = await app.pg.query(
      `SELECT * FROM reminders WHERE owner_id = $1 ${all ? "" : "AND status = 'scheduled'"} ORDER BY fire_at ASC`,
      [agentId]
    );
    return { reminders: (r.rows as any[]).map(reminderToDto) };
  });

  // 取消提醒
  app.delete("/:agentId/reminders/:reminderId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const reminderId = (req.params as any).reminderId;
    const r = await app.pg.query(
      "UPDATE reminders SET status = 'canceled', updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING id",
      [reminderId, agentId]
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    return { ok: true };
  });

  // 推迟提醒
  app.post("/:agentId/reminders/:reminderId/snooze", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const reminderId = (req.params as any).reminderId;
    const { duration } = req.body as any;
    const ms = parseDurationToMs(duration || "");
    if (!ms) return reply.status(400).send({ error: "invalid duration (e.g. 30m, 2h)" });
    const cur = await app.pg.query("SELECT fire_at FROM reminders WHERE id = $1 AND owner_id = $2", [reminderId, agentId]);
    if (cur.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    const base = Math.max(Date.now(), new Date((cur.rows[0] as any).fire_at).getTime());
    const next = new Date(base + ms);
    const r = await app.pg.query(
      "UPDATE reminders SET fire_at = $1, status = 'scheduled', updated_at = now() WHERE id = $2 AND owner_id = $3 RETURNING *",
      [next.toISOString(), reminderId, agentId]
    );
    return { reminder: reminderToDto(r.rows[0]) };
  });

  // 更新提醒
  app.patch("/:agentId/reminders/:reminderId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const reminderId = (req.params as any).reminderId;
    const body = (req.body as any) || {};
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (body.title !== undefined) { sets.push(`title = $${p++}`); params.push(body.title); }
    if (body.repeat !== undefined) { sets.push(`repeat_rule = $${p++}`); params.push(body.repeat || null); }
    if (body.fireAt || body.delaySeconds != null) {
      const f = initialFireAt(body);
      if (f) { sets.push(`fire_at = $${p++}`); params.push(f.toISOString()); }
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    sets.push("updated_at = now()");
    params.push(reminderId, agentId);
    const r = await app.pg.query(
      `UPDATE reminders SET ${sets.join(", ")} WHERE id = $${p++} AND owner_id = $${p} RETURNING *`,
      params
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    return { reminder: reminderToDto(r.rows[0]) };
  });

  // 提醒生命周期日志（简版：由字段汇总）
  app.get("/:agentId/reminders/:reminderId/log", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as any).agentId;
    const reminderId = (req.params as any).reminderId;
    const r = await app.pg.query("SELECT * FROM reminders WHERE id = $1 AND owner_id = $2", [reminderId, agentId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
    const dto = reminderToDto(r.rows[0]);
    const events = [
      { event: "created", at: dto.createdAt },
      ...(dto.lastFiredAt ? [{ event: "fired", at: dto.lastFiredAt, fireCount: dto.fireCount }] : []),
      { event: dto.status, at: (r.rows[0] as any).updated_at },
    ];
    return { reminder: dto, events };
  });

  // Update agent runtime config（agent 资料的增删改由人类侧 /api/agents 负责）
  app.patch("/:agentId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { agentId } = req.params as Record<string, string>;
    const { status, runtime, model } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (status) { sets.push("status = $" + p++); params.push(status); }
    if (runtime) { sets.push("runtime = $" + p++); params.push(runtime); }
    if (model) { sets.push("model = $" + p++); params.push(model); }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    await app.pg.query("UPDATE agents SET " + sets.join(", ") + " WHERE id = $" + p, params);
    return { ok: true };
  });
}
