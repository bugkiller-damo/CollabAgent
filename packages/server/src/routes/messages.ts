import type { FastifyInstance } from "fastify";
import { canAccessChannel, getChannelType } from "../lib/access.js";
import { appendEvent } from "../lib/audit.js";
import { cleanChannelName, resolveChannel } from "../lib/channel.js";
import { dmOtherMembers, isDmTarget, type Party, resolveDmTarget } from "../lib/dm.js";
import { inc } from "../lib/metrics.js";
import { createNotification } from "../lib/notifications.js";
import { attachmentsJson, reactionsJson } from "../lib/query-fragments.js";
import { broadcast } from "../ws/handler.js";

export async function messageRoutes(app: FastifyInstance) {
  // 从消息文本解析 @提及 的 handle（仅用于人类用户——handle 注册时限死 ASCII）
  function parseMentionHandles(content: string): string[] {
    const names = new Set<string>();
    for (const word of content.split(/\s+/)) {
      if (word.startsWith("@") && word.length > 1) {
        const name = word.slice(1).replace(/[^a-zA-Z0-9_]/g, "");
        if (name) names.add(name);
      }
    }
    return Array.from(names);
  }

  // 检测文本是否 @了某个名字：子串匹配 "@name"，且名字后不能紧跟字母/数字/下划线/中文
  // （防止 agent 名 "test" 误中 "@tester"）。支持中文 agent 名。
  function contentMentions(content: string, name: string): boolean {
    let idx = content.indexOf("@" + name);
    while (idx >= 0) {
      const after = content[idx + name.length + 1];
      if (after === undefined || !/[\p{L}\p{N}_]/u.test(after)) return true;
      idx = content.indexOf("@" + name, idx + 1);
    }
    return false;
  }

  // Get messages by channel
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, limit } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const userId = req.user.sub;
    let channelId: string;
    if (isDmTarget(channel)) {
      const me: Party = { id: userId, type: "human", handle: req.user.handle ?? "unknown" };
      const resolved = await resolveDmTarget(app, me, channel);
      if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
      channelId = resolved.channelId;
    } else {
      const ch = await resolveChannel(app, channel);
      if (!ch) return reply.status(404).send({ error: "channel not found" });
      channelId = ch.id;
    }
    if (!(await canAccessChannel(app, channelId, userId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const lim = Number(limit) || 50;
    const result = await app.pg.query(
      'SELECT m.id, m.channel_id, m.server_id, m.sender_id as "senderId", m.sender_type as "senderType", COALESCE(u.display_name, u.handle, ag.display_name, ag.name, \'User\') as "senderName", m.content, m.seq, m.thread_id, m.task_number, m.task_status, m.task_assignee, m.created_at as "time", m.edited_at as "editedAt", (SELECT COUNT(*) FROM messages WHERE thread_id = m.id)::int as "replyCount", ' +
        reactionsJson() +
        ", " +
        attachmentsJson() +
        " FROM messages m LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id WHERE m.channel_id = $1 AND m.thread_id IS NULL ORDER BY m.seq DESC LIMIT $2",
      [channelId, lim + 1], // 多取一条判断 hasMore
    );
    const hasMore = result.rows.length > lim;
    if (hasMore) result.rows.pop(); // 去掉多取的那条
    return { messages: result.rows.reverse(), hasMore };
  });

  // Get thread replies
  app.get("/thread/:messageId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const parent = await app.pg.query(
      'SELECT m.id, m.channel_id, m.content, m.sender_id as "senderId", COALESCE(u.display_name, u.handle, \'User\') as "senderName", m.created_at as "time" FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.id = $1',
      [messageId],
    );
    if (parent.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (!(await canAccessChannel(app, String(parent.rows[0].channel_id), req.user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const replies = await app.pg.query(
      'SELECT m.id, m.channel_id, m.sender_id as "senderId", COALESCE(u.display_name, u.handle, \'User\') as "senderName", m.content, m.seq, m.created_at as "time" FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.thread_id = $1 ORDER BY m.seq ASC',
      [messageId],
    );
    return { parent: parent.rows[0], replies: replies.rows };
  });

  app.post("/send", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, content, target, threadId, attachmentIds } = req.body as {
      channelId?: string;
      content?: string;
      target?: string;
      threadId?: string;
      attachmentIds?: string[];
    };
    const ids: string[] = Array.isArray(attachmentIds) ? attachmentIds : [];
    if ((!content || !content.trim()) && ids.length === 0) {
      return reply.status(400).send({ error: "content or attachment required" });
    }
    if (!target) return reply.status(400).send({ error: "target required" });
    const userId = req.user.sub;
    const senderHandle = String(req.user?.handle || "unknown");
    let resolvedChannelId = channelId;
    let resolvedServerId: string | undefined;
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
        const ch = await resolveChannel(app, target, "id, server_id");
        if (!ch) return reply.status(404).send({ error: "channel not found" });
        resolvedChannelId = ch.id;
        resolvedServerId = ch.server_id;
      }
    }
    if (!(await canAccessChannel(app, resolvedChannelId, userId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    if (!resolvedServerId) {
      const sv = await app.pg.query<{ server_id: string }>("SELECT server_id FROM channels WHERE id = $1", [
        resolvedChannelId,
      ]);
      resolvedServerId = sv.rows[0]?.server_id;
    }
    const channelType = await getChannelType(app, resolvedChannelId);
    // 消息本体 + （公开频道的）agent 自动入圈 + 附件挂载 一个事务提交。
    // （通知放在事务外：通知失败不应回滚消息本身）
    const { msg, attachments, mentionAgents } = await app.pg.transaction(async (tx) => {
      const result = await tx.query(
        "INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, thread_id) VALUES ($1, $2, $3, 'human', $4, $5) RETURNING id, seq, created_at",
        [resolvedChannelId, resolvedServerId, userId, content || "", threadId || null],
      );
      const msg = result.rows[0] as any;
      // 审计事件（O2）：与消息写入同事务，追加 message.send 事件进哈希链
      await appendEvent(tx, {
        actorId: userId,
        actorType: "human",
        verb: "message.send",
        objectType: "message",
        objectId: String(msg.id),
        payload: {
          channelId: resolvedChannelId,
          serverId: resolvedServerId ?? null,
          content: content || "",
          threadId: threadId ?? null,
        },
      });
      let mentionAgents: string[] | undefined;
      // @提及 agent：按频道类型决定「谁能被唤醒」。
      // 检测方式：对候选 agent 名做子串匹配（支持中文名；此前按 ASCII 解析 handle，
      // 会把中文名剥光——"@716测试机" 变成 "716" 查无此人，"@悬疑小说家" 直接变空串）。
      if (!dm && content && content.includes("@")) {
        if (channelType === "public") {
          // 候选集：频道所在 server 的 agent + 发送者自己名下的 agent（与 /invite 回退一致）
          const candidates = await tx.query<{ name: string }>(
            "SELECT name FROM agents WHERE server_id = $1 OR user_id = $2",
            [resolvedServerId, userId],
          );
          const mentionedNames = candidates.rows.map((r) => r.name).filter((n) => n && contentMentions(content, n));
          if (mentionedNames.length > 0) {
            // 公开频道：自动入圈，入圈后即可被唤醒
            await tx.query(
              `INSERT INTO channel_members (channel_id, member_id, member_type, role)
               SELECT $1, a.id, 'agent', 'member' FROM agents a
               WHERE a.name = ANY($2) AND (a.server_id = $3 OR a.user_id = $4)
               ON CONFLICT DO NOTHING`,
              [resolvedChannelId, mentionedNames, resolvedServerId, userId],
            );
            mentionAgents = mentionedNames;
          } else {
            mentionAgents = [];
          }
        } else {
          // 私有频道：不自动入圈（非管理员不能拉人），只唤醒「已经是成员」的 agent。
          // 不在列表里的 agent daemon 不会 spawn —— 避免起了 PTY 回复时再被 403 的资源浪费。
          const members = await tx.query<{ name: string }>(
            `SELECT a.name FROM agents a
             JOIN channel_members cm ON cm.member_id = a.id AND cm.member_type = 'agent' AND cm.channel_id = $1`,
            [resolvedChannelId],
          );
          mentionAgents = members.rows.map((r) => r.name).filter((n) => n && contentMentions(content, n));
        }
      }
      let attachments: any[] = [];
      if (ids.length > 0) {
        const values = ids.map((_, i) => `($1, $${i + 2})`).join(", ");
        await tx.query(
          `INSERT INTO message_attachments (message_id, attachment_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [msg.id, ...ids],
        );
        const att = await tx.query<{ id: string; filename: string; mimeType: string; sizeBytes: number; url: string }>(
          'SELECT id, filename, mime_type as "mimeType", size_bytes as "sizeBytes", storage_url as url FROM attachments WHERE id = ANY($1)',
          [ids],
        );
        attachments = att.rows;
      }
      return { msg, attachments, mentionAgents };
    });

    // @提及用户 → 通知（SELECT 已批量化，createNotification 含 INSERT）
    if (!dm && content && content.includes("@")) {
      const atNames = parseMentionHandles(content);
      if (atNames.length > 0) {
        const users = await app.pg.query<{ id: string; handle: string; display_name: string }>(
          "SELECT id, handle, display_name FROM users WHERE handle = ANY($1)",
          [atNames],
        );
        for (const u of users.rows) {
          if (String(u.id) !== userId) {
            await createNotification(app, {
              userId: String(u.id),
              type: "@mention",
              actorId: String(userId),
              actorName: String(senderHandle),
              channelId: resolvedChannelId,
              messageId: String(msg.id),
              title: `${senderHandle} 在消息中提到了你`,
              body: (content || "").slice(0, 200),
            });
          }
        }
      }
    }

    const senderName = req.user?.display_name || req.user?.handle || "unknown";
    // DM：浏览器侧用稳定的 dm:<uuid> 作为会话键；并附带 agent 接收方供 daemon「无需 @」唤醒
    let dmAgentRecipients: string[] | undefined;
    if (dm) {
      const others = await dmOtherMembers(app, resolvedChannelId, userId);
      dmAgentRecipients = others.agents.map((a) => a.handle);
    }
    const channelIdOut = dm ? "dm:" + resolvedChannelId : "#" + cleanChannelName(target);
    broadcast(resolvedChannelId, {
      type: "agent:deliver",
      seq: msg.seq,
      message: {
        id: msg.id,
        seq: msg.seq,
        channelId: channelIdOut,
        senderId: userId,
        senderName,
        senderHandle,
        senderType: "human",
        content: content || "",
        time: msg.created_at,
        threadId: threadId || null,
        attachments,
        // server 预过滤的「有权回应的 agent」列表：daemon 只 spawn 列表内的 agent，
        // 空数组 = 有人被 @ 但无人有权回应 → 不 spawn（避免 PTY 空转）。
        ...(mentionAgents !== undefined ? { mentionAgents } : {}),
        ...(dm ? { dm: true, dmAgentRecipients, dmPeerHandle: dmPeer?.handle } : {}),
      },
    });
    inc("messagesSent");
    if (dm) inc("dmSent");
    return {
      state: "sent",
      messageId: msg.id,
      messageSeq: msg.seq,
      attachments,
      channelId: dm ? "dm:" + resolvedChannelId : undefined,
    };
  });

  app.get("/history", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, before, after, around, limit, threadId } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const userId = req.user.sub;
    let resolvedChannelId: string;
    if (isDmTarget(channel)) {
      const me: Party = { id: userId, type: "human", handle: req.user.handle ?? "unknown" };
      const resolved = await resolveDmTarget(app, me, channel);
      if (!resolved) return reply.status(404).send({ error: "dm peer not found" });
      resolvedChannelId = resolved.channelId;
    } else if (channel.startsWith("#")) {
      const ch = await resolveChannel(app, channel);
      if (!ch) return reply.status(404).send({ error: "channel not found" });
      resolvedChannelId = ch.id;
    } else {
      resolvedChannelId = String(channel);
    }
    if (!(await canAccessChannel(app, resolvedChannelId, userId))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    let query =
      'SELECT m.id, m.channel_id, m.server_id, m.sender_id as "senderId", m.sender_type as "senderType", COALESCE(u.display_name, u.handle, ag.display_name, ag.name, \'User\') as "senderName", m.content, m.seq, m.thread_id, m.task_number, m.task_status, m.task_assignee, m.created_at as "time", m.edited_at as "editedAt", (SELECT COUNT(*) FROM messages WHERE thread_id = m.id)::int as "replyCount", ' +
      reactionsJson() +
      ", " +
      attachmentsJson() +
      " FROM messages m LEFT JOIN users u ON m.sender_id = u.id LEFT JOIN agents ag ON m.sender_id = ag.id WHERE m.channel_id = $1 AND m.thread_id IS NULL";
    const params: (string | number)[] = [resolvedChannelId];
    let p = 2;
    if (threadId) {
      query += " AND m.thread_id = $" + p++;
      params.push(threadId);
    }
    if (before) {
      query += " AND seq < $" + p++;
      params.push(Number(before));
    }
    if (after) {
      query += " AND seq > $" + p++;
      params.push(Number(after));
    }
    query += " ORDER BY seq DESC LIMIT $" + p;
    params.push(Number(limit) || 50);
    const result = await app.pg.query(query, params);
    return { messages: result.rows.reverse(), hasMore: result.rows.length >= (Number(limit) || 50) };
  });

  app.get("/search", { preHandler: [app.authenticate] }, async (req) => {
    const { q } = req.query as Record<string, string | undefined>;
    const userId = req.user.sub;
    // 仅搜调用方可见的频道：公开频道，或其为成员的私有/DM 频道
    // content_tsv 是 stored 生成列（migration 008），GIN 索引命中，不再现算 to_tsvector
    const result = await app.pg.query(
      `SELECT m.id, m.content, '#' || c.name as "channelId", m.seq, m.created_at as "time", m.sender_id as "senderId", m.sender_type as "senderType"
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id::text = $3 AND cm.member_type = 'human'
        WHERE m.content_tsv @@ plainto_tsquery('simple', $1)
          AND (c.type NOT IN ('private','dm') OR cm.member_id IS NOT NULL)
        ORDER BY m.created_at DESC LIMIT $2`,
      [q || "", 20, userId],
    );
    return { results: result.rows, total: result.rows.length };
  });

  // 编辑消息（仅本人，保留旧内容至 message_edits）
  app.put("/:messageId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const { content } = req.body as { content?: string };
    if (!content || !content.trim()) return reply.status(400).send({ error: "content required" });
    const userId = req.user.sub;
    const m = await app.pg.query<{ sender_id: string; channel_id: string; content: string | null }>(
      "SELECT sender_id, channel_id, content FROM messages WHERE id = $1",
      [messageId],
    );
    if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (String(m.rows[0].sender_id) !== String(userId)) {
      return reply.status(403).send({ error: "can only edit your own messages" });
    }
    const oldContent = String(m.rows[0].content || "");
    // 编辑历史 + 消息更新 + 审计事件 一个事务提交（O2）
    const r = await app.pg.transaction(async (tx) => {
      await tx.query("INSERT INTO message_edits (message_id, old_content, edited_by) VALUES ($1, $2, $3)", [
        messageId,
        oldContent,
        userId,
      ]);
      const updated = await tx.query<{ id: string; content: string; editedAt: string }>(
        'UPDATE messages SET content = $1, edited_at = now() WHERE id = $2 RETURNING id, content, edited_at as "editedAt"',
        [content, messageId],
      );
      await appendEvent(tx, {
        actorId: userId,
        actorType: "human",
        verb: "message.edit",
        objectType: "message",
        objectId: messageId,
        payload: { oldContent, newContent: content },
      });
      return updated.rows[0];
    });
    broadcast(String(m.rows[0].channel_id), {
      type: "message:update",
      message: { id: messageId, content, editedAt: r.editedAt },
    });
    return { message: r };
  });

  // 消息编辑历史（需频道可见性：编辑历史同样包含消息内容）
  app.get("/:messageId/edits", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const m = await app.pg.query<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = $1", [messageId]);
    if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (!(await canAccessChannel(app, String(m.rows[0].channel_id), req.user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const r = await app.pg.query(
      "SELECT id, old_content, edited_by, edited_at FROM message_edits WHERE message_id = $1 ORDER BY edited_at ASC",
      [messageId],
    );
    return { edits: r.rows };
  });

  app.post("/:messageId/reactions", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const { emoji } = req.body as Record<string, unknown>;
    const m = await app.pg.query<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = $1", [messageId]);
    if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (!(await canAccessChannel(app, String(m.rows[0].channel_id), req.user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    await app.pg.query(
      "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [messageId, req.user.sub, emoji as string],
    );
    return { ok: true };
  });

  // 删除表情反应
  app.delete("/:messageId/reactions/:emoji", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId, emoji } = req.params as Record<string, string>;
    const m = await app.pg.query<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = $1", [messageId]);
    if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (!(await canAccessChannel(app, String(m.rows[0].channel_id), req.user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    await app.pg.query("DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3", [
      messageId,
      req.user.sub,
      emoji,
    ]);
    return { ok: true };
  });

  // 删除消息（仅本人）
  app.delete("/:messageId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params as Record<string, string>;
    const userId = req.user.sub;
    const m = await app.pg.query("SELECT sender_id, channel_id FROM messages WHERE id = $1", [messageId]);
    if (m.rows.length === 0) return reply.status(404).send({ error: "message not found" });
    if (String(m.rows[0].sender_id) !== String(userId)) {
      return reply.status(403).send({ error: "can only delete your own messages" });
    }
    // 先删 reactions / attachments（如果有）防止 FK 悬挂
    // 不级联删 thread replies（保留历史），仅软删父消息内容
    // 审计事件（O2）：删除 + 追加 message.delete 事件一个事务提交
    await app.pg.transaction(async (tx) => {
      await tx.query("DELETE FROM message_reactions WHERE message_id = $1", [messageId]);
      await tx.query("DELETE FROM message_attachments WHERE message_id = $1", [messageId]);
      await tx.query(
        "UPDATE messages SET content = '', task_number = NULL, task_status = NULL, task_assignee = NULL WHERE id = $1",
        [messageId],
      );
      await appendEvent(tx, {
        actorId: userId,
        actorType: "human",
        verb: "message.delete",
        objectType: "message",
        objectId: messageId,
        payload: {},
      });
    });
    broadcast(String(m.rows[0].channel_id), { type: "message:delete", message: { id: messageId } });
    return { ok: true };
  });
}
