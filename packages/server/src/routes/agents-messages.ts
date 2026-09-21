import type { FastifyInstance } from "fastify";
import {
  agentCanAccessChannel,
  getAgent,
  requireOwnAgent,
  resolveAgentChannelByName,
  resolveAgentChannelDbId,
} from "../lib/agent-helpers.js";
import { filterAuthorizedAttachmentIds } from "../lib/attachment-access.js";
import { dmOtherMembers, isDmTarget, type Party, resolveDmTarget } from "../lib/dm.js";
import { attachmentsJson } from "../lib/query-fragments.js";
import { UUID_RE } from "../lib/tenant.js";
import { handleAttachmentUpload } from "../lib/upload.js";
import { MAX_MESSAGE_CONTENT_LEN } from "../lib/validators.js";
import { broadcast } from "../ws/handler.js";

export async function agentMessageRoutes(app: FastifyInstance) {
  app.post("/:agentId/send", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const { target, content, threadId, attachmentIds, idempotencyKey } = req.body as Record<string, unknown>;
    const agentId = (req.params as Record<string, string>).agentId;
    const attIds: string[] = Array.isArray(attachmentIds) ? (attachmentIds as string[]) : [];
    if (!target) return reply.status(400).send({ error: "target required" });
    // Phase 5 §15.4：agent 写操作幂等。worker SDK 按 <turnId>:<tool>:<seq> 生成
    // idempotencyKey；存进 messages.client_nonce 复用既有部分唯一索引
    // (channel_id, client_nonce)，前缀 ag:<agentId>: 把作用域收窄到本 agent——
    // 不同 agent 的 turnId 序号天然同形，裸 key 会在同频道互撞。
    let clientNonce: string | undefined;
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9:._-]{8,160}$/.test(idempotencyKey)) {
        return reply.status(400).send({ error: "invalid idempotencyKey" });
      }
      clientNonce = `ag:${agentId}:${idempotencyKey}`;
    }
    // P1.33：与人类侧 /api/messages/send 同口径的 content 上限
    if (typeof content === "string" && content.length > MAX_MESSAGE_CONTENT_LEN) {
      return reply.status(400).send({ error: `content too long (max ${MAX_MESSAGE_CONTENT_LEN})` });
    }
    const agent = await getAgent(app, agentId);
    const tstr = target as string;
    const dm = isDmTarget(tstr);
    let channelDbId: string, serverId: string;
    if (dm) {
      const me: Party = { id: agentId, type: "agent", handle: agent?.name || "agent" };
      const resolved = await resolveDmTarget(app, me, tstr);
      if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
      channelDbId = resolved.channelId;
      const sv = await app.pg.query<{ server_id: string }>("SELECT server_id FROM channels WHERE id = $1", [
        channelDbId,
      ]);
      serverId = sv.rows[0]?.server_id;
    } else {
      // 2026-09-17 审计 F4 修复：候选集口径解析（agent server ∪ 属主 orgs ∪ 单租户默认社区）
      const ch = await resolveAgentChannelByName(app, agentId, tstr);
      if (!ch) return reply.status(404).send({ error: "channel not found" });
      channelDbId = String(ch.id);
      serverId = String(ch.server_id);
    }
    if (!(await agentCanAccessChannel(app, channelDbId, agentId)))
      return reply.status(403).send({ error: "no access" });
    let resolvedThreadId: string | null = (threadId as string) || null;
    if (resolvedThreadId) {
      // P1.33：显式 threadId 与人类侧同口径——必须存在且属于本频道（此前原样进 INSERT：
      // 不存在撞 FK 500、异频道跨频道错乱）。target 的 ":shortid" 前缀路径本就按
      // channel_id 圈定（下分支），无需再验。
      if (!UUID_RE.test(resolvedThreadId)) return reply.status(400).send({ error: "invalid threadId" });
      const parent = await app.pg.query<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = $1", [
        resolvedThreadId,
      ]);
      if (parent.rows.length === 0 || String(parent.rows[0].channel_id) !== String(channelDbId)) {
        return reply.status(400).send({ error: "thread not found in this channel" });
      }
    } else {
      const parts = tstr.split(":");
      const shortid = dm ? parts[2] : parts[1];
      if (shortid) {
        const parent = await app.pg.query<{ id: number }>(
          "SELECT id FROM messages WHERE channel_id = $1 AND id::text LIKE $2 ORDER BY seq ASC LIMIT 1",
          [channelDbId, shortid + "%"],
        );
        if (parent.rows[0]) resolvedThreadId = String(parent.rows[0].id);
      }
    }
    const result = clientNonce
      ? await app.pg.query(
          `INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id, client_nonce)
           VALUES ($1, $2, $3, 'agent', $4, $5, $6)
           ON CONFLICT (channel_id, client_nonce) WHERE client_nonce IS NOT NULL DO NOTHING
           RETURNING id, seq, created_at`,
          [channelDbId, serverId, agentId, (content as string) || "", resolvedThreadId, clientNonce],
        )
      : await app.pg.query(
          "INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id) VALUES ($1, $2, $3, 'agent', $4, $5) RETURNING id, seq, created_at",
          [channelDbId, serverId, agentId, (content as string) || "", resolvedThreadId],
        );
    // 幂等重放：INSERT 撞唯一索引 → 首次发送已成功，查原消息原样返回，
    // 不重广播、不重挂附件、不重复计数（worker 崩溃重放走这条路）
    if (result.rows.length === 0) {
      const existed = await app.pg.query<{ id: string; seq: number }>(
        "SELECT id, seq FROM messages WHERE channel_id = $1 AND client_nonce = $2",
        [channelDbId, clientNonce],
      );
      return {
        state: "sent",
        messageId: existed.rows[0]?.id,
        messageSeq: existed.rows[0]?.seq,
        attachments: [],
        channelId: dm ? "dm:" + channelDbId : undefined,
        deduplicated: true,
      };
    }
    const msg = result.rows[0] as { id: string; seq: number; created_at: string };
    let attachments: any[] = [];
    if (attIds.length > 0 && agent) {
      // 2026-09-17 审计 F1（高危）修复：与人类侧 /send 同口径的绑定授权过滤——
      // 访问判定按属主 user_id；上传者主体含 agentId（agent 上传的行 uploader_id
      // 是 agentId）与属主。无权/不存在的 id 静默过滤，防 agent 搬运他人私信附件
      // 进公开频道（daemon 会把历史消息里的附件 URL 喂给 agent，MCP send 可传任意
      // attachmentIds）。
      const bindable = await filterAuthorizedAttachmentIds(app, String(agent.user_id), attIds, [
        agentId,
        String(agent.user_id),
      ]);
      for (const aid of bindable)
        await app.pg.query(
          "INSERT INTO message_attachments (message_id, attachment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [msg.id, aid],
        );
      if (bindable.length > 0) {
        const att = await app.pg.query(
          // F7：url 发 /api/attachments/<id>（ACL 端点），不发 storage_url capability URL
          `SELECT id, filename, mime_type as "mimeType", size_bytes as "sizeBytes", ('/api/attachments/' || id) as url FROM attachments WHERE id = ANY($1)`,
          [bindable],
        );
        attachments = att.rows;
      }
    }
    let dmAgentRecipients: string[] | undefined;
    if (dm) {
      const others = await dmOtherMembers(app, channelDbId, agentId);
      dmAgentRecipients = others.agents.map((a) => a.handle);
    }
    broadcast(channelDbId, {
      type: "agent:deliver",
      seq: msg.seq,
      message: {
        id: msg.id,
        seq: msg.seq,
        channelId: dm ? "dm:" + channelDbId : "#" + (tstr.startsWith("#") ? tstr.slice(1).split(":")[0] : tstr),
        serverId,
        senderId: agentId,
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
    return {
      state: "sent",
      messageId: msg.id,
      messageSeq: msg.seq,
      attachments,
      channelId: dm ? "dm:" + channelDbId : undefined,
    };
  });

  /**
   * T4/D4：agent 原地更新自己的消息（进度条节流改写 / 代发改写）。
   * 高频路径：不写 message_edits、不进审计链（人类编辑仍走 /api/messages PUT）。
   */
  app.put("/:agentId/messages/:messageId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const { agentId, messageId } = req.params as Record<string, string>;
    const { content } = req.body as { content?: string };
    if (typeof content !== "string") return reply.status(400).send({ error: "content required" });
    if (content.length > MAX_MESSAGE_CONTENT_LEN) {
      return reply.status(400).send({ error: `content too long (max ${MAX_MESSAGE_CONTENT_LEN})` });
    }
    const m = await app.pg.query<{ sender_id: string; sender_type: string; channel_id: string }>(
      "SELECT sender_id, sender_type, channel_id FROM messages WHERE id = $1",
      [messageId],
    );
    if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (String(m.rows[0].sender_id) !== String(agentId) || m.rows[0].sender_type !== "agent") {
      return reply.status(403).send({ error: "can only edit your own agent messages" });
    }
    // P1.33：被移出私有频道的 agent 不得再改自己的旧消息（与人类侧同口径）
    if (!(await agentCanAccessChannel(app, String(m.rows[0].channel_id), agentId))) {
      return reply.status(403).send({ error: "no access" });
    }
    const updated = await app.pg.query<{ id: string; content: string; editedAt: string }>(
      'UPDATE messages SET content = $1, edited_at = now() WHERE id = $2 RETURNING id, content, edited_at as "editedAt"',
      [content, messageId],
    );
    const r = updated.rows[0];
    broadcast(String(m.rows[0].channel_id), {
      type: "message:update",
      message: { id: messageId, content, editedAt: r.editedAt },
    });
    return { message: r };
  });

  /**
   * T4/D4：agent 删除自己的进度消息。有线程回复则软删（与人类删除一致），否则硬删以免历史残留。
   */
  app.delete(
    "/:agentId/messages/:messageId",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const { agentId, messageId } = req.params as Record<string, string>;
      const m = await app.pg.query<{ sender_id: string; sender_type: string; channel_id: string }>(
        "SELECT sender_id, sender_type, channel_id FROM messages WHERE id = $1",
        [messageId],
      );
      if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
      if (String(m.rows[0].sender_id) !== String(agentId) || m.rows[0].sender_type !== "agent") {
        return reply.status(403).send({ error: "can only delete your own agent messages" });
      }
      // P1.33：与编辑同口径——被移出私有频道后不得再删旧消息并触发广播
      if (!(await agentCanAccessChannel(app, String(m.rows[0].channel_id), agentId))) {
        return reply.status(403).send({ error: "no access" });
      }
      const kids = await app.pg.query("SELECT 1 FROM messages WHERE thread_id = $1 LIMIT 1", [messageId]);
      if (kids.rows.length > 0) {
        await app.pg.query("UPDATE messages SET content = '' WHERE id = $1", [messageId]);
      } else {
        await app.pg.query("DELETE FROM message_reactions WHERE message_id = $1", [messageId]);
        await app.pg.query("DELETE FROM message_attachments WHERE message_id = $1", [messageId]);
        await app.pg.query("DELETE FROM messages WHERE id = $1", [messageId]);
      }
      broadcast(String(m.rows[0].channel_id), { type: "message:delete", message: { id: messageId } });
      return { ok: true };
    },
  );

  app.get("/:agentId/receive", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const agent = await getAgent(app, agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    if (agent.last_seen_seq === null || agent.last_seen_seq === undefined) {
      const maxR = await app.pg.query("SELECT COALESCE(MAX(seq), 0)::bigint as max FROM messages");
      await app.pg.query("UPDATE agents SET last_seen_seq = $1 WHERE id = $2", [maxR.rows[0].max, agentId]);
      return { messages: [] };
    }
    const result = await app.pg.query(
      `SELECT m.id, m.seq, c.name as channel, CASE WHEN c.type = 'dm' THEN 'dm:@' || (SELECT COALESCE(u2.handle, a2.name) FROM channel_members cm2 LEFT JOIN users u2 ON cm2.member_type='human' AND cm2.member_id=u2.id LEFT JOIN agents a2 ON cm2.member_type='agent' AND cm2.member_id=a2.id WHERE cm2.channel_id = c.id AND cm2.member_id::text <> $1::text LIMIT 1) ELSE '#' || c.name END as "channelId", (c.type = 'dm') as "isDm", COALESCE(u.display_name, u.handle, ag.display_name, ag.name, '?') as "senderName", m.sender_type as "senderType", m.content, m.created_at as time, ${attachmentsJson()} FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1 AND cm.member_type = 'agent' WHERE c.server_id = $2 AND c.archived = false AND m.thread_id IS NULL AND m.seq > $3 AND m.sender_id <> $1 AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL) ORDER BY m.seq DESC LIMIT 50`,
      [agentId, agent.server_id, agent.last_seen_seq],
    );
    const messages = result.rows.reverse();
    if (messages.length > 0) {
      const maxSeq = messages[messages.length - 1].seq;
      await app.pg.query("UPDATE agents SET last_seen_seq = $1 WHERE id = $2", [maxSeq, agentId]);
    }
    return { messages };
  });

  app.get("/:agentId/history", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, limit, threadId } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const channelDbId = await resolveAgentChannelDbId(app, agentId, channel);
    if (!channelDbId) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, channelDbId, agentId)))
      return reply.status(403).send({ error: "no access" });
    const historySelect = `SELECT m.id, m.seq, CASE WHEN c.type = 'dm' THEN 'dm:@' || (SELECT COALESCE(u2.handle, a2.name) FROM channel_members cm2 LEFT JOIN users u2 ON cm2.member_type='human' AND cm2.member_id=u2.id LEFT JOIN agents a2 ON cm2.member_type='agent' AND cm2.member_id=a2.id WHERE cm2.channel_id = c.id AND cm2.member_id::text <> $3::text LIMIT 1) ELSE '#' || c.name END as "channelId", COALESCE(u.display_name, u.handle, ag.display_name, ag.name, '?') as "senderName", m.sender_type as "senderType", m.content, m.created_at as time, ${attachmentsJson()} FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id`;
    const lim = Number(limit) || 50;
    if (threadId) {
      const parent = await app.pg.query<{ id: string }>(
        "SELECT id FROM messages WHERE channel_id = $1 AND (id::text = $2 OR id::text LIKE $3) ORDER BY seq ASC LIMIT 1",
        [channelDbId, threadId, threadId + "%"],
      );
      const parentId = parent.rows[0]?.id;
      if (!parentId) return { messages: [] };
      const result = await app.pg.query(
        `${historySelect} WHERE m.channel_id = $1 AND (m.id = $4::uuid OR m.thread_id = $4::uuid) ORDER BY m.seq DESC LIMIT $2`,
        [channelDbId, lim, agentId, parentId],
      );
      return { messages: result.rows.reverse() };
    }
    const result = await app.pg.query(
      `${historySelect} WHERE m.channel_id = $1 AND m.thread_id IS NULL ORDER BY m.seq DESC LIMIT $2`,
      [channelDbId, lim, agentId],
    );
    return { messages: result.rows.reverse() };
  });

  app.get("/:agentId/server", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const agent = await getAgent(app, agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const [channels, agents, humans] = await Promise.all([
      app.pg.query(
        `SELECT c.id, c.name, c.description, c.type, (cm.member_id IS NOT NULL) as joined FROM channels c LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1 AND cm.member_type = 'agent' WHERE c.server_id = $2 AND c.archived = false AND c.type <> 'dm' AND (c.type <> 'private' OR cm.member_id IS NOT NULL) ORDER BY c.created_at`,
        [agentId, agent.server_id],
      ),
      app.pg.query("SELECT id, name, display_name, avatar_url FROM agents WHERE server_id = $1", [agent.server_id]),
      app.pg.query("SELECT id, handle, display_name FROM users ORDER BY handle"),
    ]);
    return { serverId: agent.server_id, channels: channels.rows, agents: agents.rows, humans: humans.rows };
  });

  app.get("/:agentId/channel-members", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const channelDbId = await resolveAgentChannelDbId(app, agentId, channel);
    if (!channelDbId) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, channelDbId, agentId)))
      return reply.status(403).send({ error: "no access" });
    const result = await app.pg.query(
      `SELECT cm.member_id, cm.member_type, cm.role, cm.is_manager, COALESCE(u.handle, a.name) as handle, COALESCE(u.display_name, a.display_name) as display_name FROM channel_members cm LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id WHERE cm.channel_id = $1`,
      [channelDbId],
    );
    return { members: result.rows };
  });

  app.post("/:agentId/upload", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    // F2/F3：与人类侧同一校验链（文件名净化 + per-file 大小兜底收编后天然对齐）
    const agentId = (req.params as Record<string, string>).agentId;
    return handleAttachmentUpload(app, req, reply, { id: agentId, type: "agent" });
  });

  app.post(
    "/:agentId/messages/:messageId/reactions",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        messageId = (req.params as Record<string, string>).messageId,
        { emoji } = req.body as { emoji?: string };
      // 2026-09-17 审计 F2 修复：补频道 ACL——此前完全缺失，任意 agent 可对
      // 私有频道/DM 的任意 messageId 写 reaction（边界破坏 + 存在性探测）。
      // 与人类侧同口径：先验消息存在，再验 agent 对所在频道可访问。不存在的
      // 消息与无权访问统一 404，不泄露私有频道消息存在性。
      const m = await app.pg.query<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = $1", [
        messageId,
      ]);
      if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
      if (!(await agentCanAccessChannel(app, String(m.rows[0].channel_id), agentId))) {
        return reply.status(404).send({ error: "message not found" });
      }
      await app.pg.query(
        "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [messageId, agentId, emoji],
      );
      return { ok: true };
    },
  );
  app.delete(
    "/:agentId/messages/:messageId/reactions",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        messageId = (req.params as Record<string, string>).messageId,
        { emoji } = req.body as { emoji?: string };
      // 2026-09-17 审计 F2 修复：与 POST 同口径的频道 ACL
      const m = await app.pg.query<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = $1", [
        messageId,
      ]);
      if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
      if (!(await agentCanAccessChannel(app, String(m.rows[0].channel_id), agentId))) {
        return reply.status(404).send({ error: "message not found" });
      }
      await app.pg.query("DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3", [
        messageId,
        agentId,
        emoji,
      ]);
      return { ok: true };
    },
  );

  app.get("/:agentId/search", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { q, channel, limit } = req.query as Record<string, string>;
    if (!q) return reply.status(400).send({ error: "query required" });
    const agent = await getAgent(app, agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const params: any[] = [q, agent.server_id, agentId];
    let chFilter = "";
    if (channel) {
      // 2026-09-17 审计 F4 修复：同 send——候选集口径解析，防跨社区同名串号
      const ch = await resolveAgentChannelByName(app, agentId, channel, "id");
      if (!ch) return reply.status(404).send({ error: "channel not found" });
      params.push(String(ch.id));
      chFilter = ` AND m.channel_id = $${params.length}`;
    }
    params.push(Number(limit) || 20);
    const result = await app.pg.query(
      `SELECT m.id, m.content, m.seq, '#' || c.name as "channelId", m.created_at as time FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $3 AND cm.member_type = 'agent' WHERE c.server_id = $2 AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL) AND to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1)${chFilter} ORDER BY m.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { results: result.rows, total: result.rows.length };
  });
}
