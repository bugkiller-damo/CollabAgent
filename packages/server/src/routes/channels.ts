import type { FastifyInstance } from "fastify";
import { canAccessChannel, canManageChannel, invalidateChannel, invalidateMember } from "../lib/access.js";
import { resolveChannel } from "../lib/channel.js";
import { getOrCreateDmChannel, type Party, resolvePeer } from "../lib/dm.js";
import { getStorage } from "../lib/storage.js";
import { isServerMember, resolveTenant } from "../lib/tenant.js";

export async function channelRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.query as Record<string, string>;
    // O3：请求级租户解析——显式 serverId/header/host 必须校验成员身份，防止任意 serverId 枚举
    const tenant = await resolveTenant(app, req, { serverId });
    if (tenant.explicit && !(await isServerMember(app, tenant.serverId, req.user.sub))) {
      return reply.status(403).send({ error: "not a member of that server" });
    }
    const resolvedServerId = tenant.serverId;
    if (!resolvedServerId) return { channels: [] };
    const result = await app.pg.query(
      `SELECT c.*, cm.role
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id::text = $1
       WHERE c.server_id = $2 AND c.archived = false AND c.type <> 'dm'
         AND (c.type <> 'private' OR cm.role IS NOT NULL)
       ORDER BY c.created_at`,
      [req.user.sub, resolvedServerId],
    );
    return { channels: result.rows };
  });

  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId, name, description, type, visibility } = req.body as Record<string, unknown>;
    if (!name) return reply.status(400).send({ error: "name required" });
    const tenant = await resolveTenant(app, req, { serverId: serverId as string | undefined });
    if (tenant.explicit && !(await isServerMember(app, tenant.serverId, req.user.sub))) {
      return reply.status(403).send({ error: "not a member of that server" });
    }
    const resolvedServerId = tenant.serverId;
    if (!resolvedServerId) return reply.status(400).send({ error: "no server available" });
    const vis = visibility || type || "public";
    const userId = req.user.sub;
    const exists = await app.pg.query("SELECT 1 FROM channels WHERE server_id = $1 AND name = $2", [
      resolvedServerId,
      name,
    ]);
    if (exists.rows.length > 0) return reply.status(409).send({ error: "channel already exists" });
    // 频道创建 + 创建者入圈 必须同事务，否则第二步失败会留下无 owner 的频道
    const channel = await app.pg.transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO channels (server_id, name, description, type, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [resolvedServerId, name, description || null, vis, userId],
      );
      const ch = result.rows[0] as any;
      await tx.query(
        `INSERT INTO channel_members (channel_id, member_id, member_type, role)
         VALUES ($1, $2, 'human', 'owner') ON CONFLICT DO NOTHING`,
        [ch.id, userId],
      );
      return ch;
    });
    return { channel };
  });

  app.patch("/:channelId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as Record<string, string>;
    if (!(await canManageChannel(app, channelId, req.user.sub))) {
      return reply.status(403).send({ error: "only channel admins can modify this channel" });
    }
    const { description, type, visibility, archived, managerTriageEnabled } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (description !== undefined) {
      sets.push(`description = $${p++}`);
      params.push(description || null);
    }
    const vis = visibility ?? type;
    if (vis !== undefined) {
      sets.push(`type = $${p++}`);
      params.push(vis);
    }
    if (archived !== undefined) {
      sets.push(`archived = $${p++}`);
      params.push(!!archived);
    }
    if (managerTriageEnabled !== undefined) {
      if (typeof managerTriageEnabled !== "boolean") {
        return reply.status(400).send({ error: "managerTriageEnabled must be boolean" });
      }
      if (managerTriageEnabled) {
        const mgr = await app.pg.query(
          `SELECT 1 FROM channel_members
            WHERE channel_id = $1 AND member_type = 'agent' AND is_manager = true
            LIMIT 1`,
          [channelId],
        );
        if (mgr.rows.length === 0) {
          return reply.status(400).send({ error: "channel has no manager agent" });
        }
      }
      sets.push(`manager_triage_enabled = $${p++}`);
      params.push(managerTriageEnabled);
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields to update" });
    sets.push(`updated_at = now()`);
    params.push(channelId);
    const result = await app.pg.query(`UPDATE channels SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`, params);
    if (result.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    // O7：类型/可见性变更立即失效权限缓存（下一次判定即新值，不等 TTL）
    invalidateChannel(channelId);
    return { channel: result.rows[0] };
  });

  app.get("/:channelId/members", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as Record<string, string>;
    if (!(await canAccessChannel(app, channelId, req.user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const result = await app.pg.query(
      `SELECT cm.member_id, cm.member_type, cm.role, cm.is_manager, cm.joined_at,
              COALESCE(u.handle, a.name) as handle,
              COALESCE(u.display_name, a.display_name) as display_name
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
       WHERE cm.channel_id = $1`,
      [channelId],
    );
    return { members: result.rows };
  });

  app.post("/:channelId/join", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as Record<string, string>;
    const { memberType } = (req.body as { memberType?: string }) || {};
    // 私有频道 / DM 不允许自主加入：必须由管理员通过 /invite 拉人，否则拿到
    // 频道 UUID 即可绕过邀请制直接成为成员。
    const ch = await app.pg.query<{ type: string }>("SELECT type FROM channels WHERE id = $1", [channelId]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    if (ch.rows[0].type !== "public") {
      return reply.status(403).send({ error: "private channels require an invite" });
    }
    await app.pg.query(
      `INSERT INTO channel_members (channel_id, member_id, member_type)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [channelId, req.user.sub, memberType || "human"],
    );
    invalidateMember(channelId, req.user.sub); // O7：新成员角色立即生效
    return { ok: true };
  });

  app.post("/:channelId/leave", { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as Record<string, string>;
    await app.pg.query(`DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2`, [
      channelId,
      req.user.sub,
    ]);
    invalidateMember(channelId, req.user.sub); // O7：退出后立即失去访问权
    return { ok: true };
  });

  // 邀请成员：按 handle 查找用户或 agent 并加入频道
  app.post("/:channelId/invite", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as Record<string, string>;
    if (!(await canManageChannel(app, channelId, req.user.sub))) {
      return reply.status(403).send({ error: "only channel admins can invite members" });
    }
    const { handle } = req.body as { handle?: string };
    if (!handle) return reply.status(400).send({ error: "handle required" });
    const clean = handle.replace(/^@/, "");
    // 先找用户，找不到再找 agent
    const user = await app.pg.query<{ id: string }>("SELECT id FROM users WHERE handle = $1", [clean]);
    let memberId: string | null = null;
    let memberType: "human" | "agent" | null = null;
    if (user.rows.length > 0) {
      memberId = String(user.rows[0].id);
      memberType = "human";
    } else {
      const ch = await app.pg.query<{ server_id: string }>("SELECT server_id FROM channels WHERE id = $1", [channelId]);
      // 先按频道所在 server 找（同 server 的团队 agent）；找不到再退回"当前用户自己名下的
      // agent"，不管它挂在哪个 server 下——agent 默认落在创建者的私有 server，跟频道所在
      // server 天然不一致（尤其是频道建在共享的 Default Server 时），邀请自己的 agent 不应
      // 该被这个边界卡住。
      let agent = await app.pg.query<{ id: string }>("SELECT id FROM agents WHERE name = $1 AND server_id = $2", [
        clean,
        ch.rows[0]?.server_id,
      ]);
      if (agent.rows.length === 0) {
        agent = await app.pg.query<{ id: string }>("SELECT id FROM agents WHERE name = $1 AND user_id = $2", [
          clean,
          req.user.sub,
        ]);
      }
      if (agent.rows.length > 0) {
        memberId = String(agent.rows[0].id);
        memberType = "agent";
      }
    }
    if (!memberId || !memberType) return reply.status(404).send({ error: "user or agent not found" });
    const exists = await app.pg.query(
      "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = $3",
      [channelId, memberId, memberType],
    );
    if (exists.rows.length > 0) return reply.status(409).send({ error: "already a member" });
    await app.pg.query(
      `INSERT INTO channel_members (channel_id, member_id, member_type, role)
       VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`,
      [channelId, memberId, memberType],
    );
    invalidateMember(channelId, memberId); // O7：受邀成员立即可访问
    return { ok: true, memberType };
  });

  // 移除成员
  app.delete("/:channelId/members/:memberId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, memberId } = req.params as Record<string, string>;
    const userId = req.user.sub;
    // 允许管理员移除他人，或成员主动退出
    if (memberId !== userId && !(await canManageChannel(app, channelId, userId))) {
      return reply.status(403).send({ error: "only channel admins can remove members" });
    }
    await app.pg.query(`DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2`, [channelId, memberId]);
    invalidateMember(channelId, memberId); // O7：被移除成员立即失去访问权
    return { ok: true };
  });

  // 角色分配：管理员 / 普通成员；is_manager：指定/取消该 agent 为频道的经理（是否启用由用户自己决定）
  app.patch("/:channelId/members/:memberId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, memberId } = req.params as Record<string, string>;
    if (!(await canManageChannel(app, channelId, req.user.sub))) {
      return reply.status(403).send({ error: "only channel admins can change roles" });
    }
    const { role, is_manager } = req.body as { role?: string; is_manager?: boolean };
    if (role === undefined && is_manager === undefined) {
      return reply.status(400).send({ error: "role or is_manager required" });
    }
    if (role !== undefined) {
      if (!["admin", "member", "owner"].includes(role)) {
        return reply.status(400).send({ error: "invalid role" });
      }
      await app.pg.query(`UPDATE channel_members SET role = $1 WHERE channel_id = $2 AND member_id = $3`, [
        role,
        channelId,
        memberId,
      ]);
    }
    if (is_manager !== undefined) {
      const member = await app.pg.query<{ member_type: string }>(
        "SELECT member_type FROM channel_members WHERE channel_id = $1 AND member_id = $2",
        [channelId, memberId],
      );
      if (member.rows.length === 0) return reply.status(404).send({ error: "member not found" });
      if (member.rows[0].member_type !== "agent") {
        return reply.status(400).send({ error: "only agents can be designated as channel manager" });
      }
      try {
        await app.pg.query(`UPDATE channel_members SET is_manager = $1 WHERE channel_id = $2 AND member_id = $3`, [
          is_manager,
          channelId,
          memberId,
        ]);
      } catch (err: any) {
        if (err?.code === "23505") return reply.status(409).send({ error: "channel already has a manager" });
        throw err;
      }
    }
    invalidateMember(channelId, memberId); // O7：角色变更立即生效（admin/owner 提升与撤销）
    return { ok: true };
  });

  // 删除频道（连带成员与消息，事务保证要么全删要么不删）
  app.delete("/:channelId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as Record<string, string>;
    if (!(await canManageChannel(app, channelId, req.user.sub))) {
      return reply.status(403).send({ error: "only channel admins can delete this channel" });
    }
    const ch = await app.pg.query("SELECT id FROM channels WHERE id = $1", [channelId]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    const orphanedKeys = await app.pg.transaction(async (tx) => {
      // 删 message_attachments 之前先收集本频道消息关联过的附件 id（删行后对象字节要在事务外 best-effort 清理）
      const linked = await tx.query<{ attachment_id: string }>(
        `SELECT DISTINCT attachment_id FROM message_attachments
          WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)`,
        [channelId],
      );
      const ids = linked.rows.map((r) => String(r.attachment_id));
      await tx.query(
        "DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)",
        [channelId],
      );
      await tx.query(
        "DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)",
        [channelId],
      );
      // 只删不再被任何消息引用的附件行（同一附件可能挂在别的频道/消息上，不能误删）
      let removedKeys: string[] = [];
      if (ids.length > 0) {
        const removed = await tx.query<{ storage_key: string }>(
          `DELETE FROM attachments
            WHERE id = ANY($1) AND NOT EXISTS (
              SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = attachments.id
            )
            RETURNING storage_key`,
          [ids],
        );
        removedKeys = removed.rows.map((r) => r.storage_key);
      }
      await tx.query("DELETE FROM action_cards WHERE channel_id = $1", [channelId]);
      await tx.query("DELETE FROM messages WHERE channel_id = $1", [channelId]);
      await tx.query("DELETE FROM channel_members WHERE channel_id = $1", [channelId]);
      await tx.query("DELETE FROM channels WHERE id = $1", [channelId]);
      return removedKeys;
    });
    // 事务提交后再删对象字节：引用关系已断；失败仅告警（best-effort），不影响频道删除结果
    for (const key of orphanedKeys) {
      try {
        await getStorage().remove(key);
      } catch (err) {
        req.log.warn({ err, key }, "attachment storage cleanup failed");
      }
    }
    // O7：频道已删，失效其类型与全部成员角色缓存
    invalidateChannel(channelId);
    invalidateMember(channelId);
    return { ok: true };
  });

  app.get("/resolve", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target, serverId } = req.query as Record<string, string>;
    if (!target) return reply.status(400).send({ error: "target required" });
    // O3：显式租户下名字解析限定在租户 server 内（同名频道/agent 跨社区不串号）
    const tenant = await resolveTenant(app, req, { serverId });
    if (tenant.explicit && !(await isServerMember(app, tenant.serverId, req.user.sub))) {
      return reply.status(403).send({ error: "not a member of that server" });
    }
    const scope = tenant.explicit ? tenant.serverId : undefined;
    if (target.startsWith("dm:@")) {
      const userId = req.user.sub;
      const peer = await resolvePeer(app, target.slice(3).split(":")[0], scope);
      if (!peer) return reply.status(404).send({ error: "peer not found" });
      const me: Party = { id: userId, type: "human", handle: req.user.handle ?? "unknown" };
      const channelId = await getOrCreateDmChannel(app, me, peer);
      // dmKey：浏览器侧统一会话键，与 WS 投递 channelId 一致
      return { type: "dm", channelId, dmKey: "dm:" + channelId, peer };
    }
    // resolveChannel 内部会清理 "#"/线程后缀；显式租户下限定在租户 server 内
    const ch = await resolveChannel(app, target, "*", scope);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    return { type: "channel", ...ch };
  });

  // 我的 DM 会话列表（含对端信息与最近一条消息）
  app.get("/dms", { preHandler: [app.authenticate] }, async (req) => {
    const userId = req.user.sub;
    const r = await app.pg.query(
      `SELECT c.id as "channelId",
              peer.member_id as "peerId", peer.member_type as "peerType",
              COALESCE(pu.handle, pa.name) as "peerHandle",
              COALESCE(pu.display_name, pa.display_name, pu.handle, pa.name) as "peerName",
              pu.avatar_url as "peerAvatar",
              lm.content as "lastContent", lm.created_at as "lastTime", lm.seq as "lastSeq"
         FROM channels c
         JOIN channel_members me ON me.channel_id = c.id AND me.member_id::text = $1 AND me.member_type = 'human'
         JOIN channel_members peer ON peer.channel_id = c.id AND NOT (peer.member_id::text = $1 AND peer.member_type = 'human')
         LEFT JOIN users pu ON peer.member_type = 'human' AND peer.member_id = pu.id
         LEFT JOIN agents pa ON peer.member_type = 'agent' AND peer.member_id = pa.id
         LEFT JOIN LATERAL (
           SELECT content, created_at, seq FROM messages
            WHERE channel_id = c.id AND thread_id IS NULL ORDER BY seq DESC LIMIT 1
         ) lm ON true
        WHERE c.type = 'dm'
        ORDER BY lm.seq DESC NULLS LAST`,
      [userId],
    );
    return { dms: r.rows };
  });

  app.get("/server", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.query as Record<string, string>;
    // 校验调用者是该 server 成员，否则任意 serverId 可枚举他人组织的频道/成员
    const member = await app.pg.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2", [
      serverId,
      req.user.sub,
    ]);
    if (member.rows.length === 0) return reply.status(403).send({ error: "not a member of that server" });
    const [channels, agents, humans] = await Promise.all([
      app.pg.query(
        // P0.9：私有频道过滤对齐 GET / 谓词——非成员不可枚举私有频道的名称/描述
        `SELECT c.*, cm.role
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id::text = $1
         WHERE c.server_id = $2 AND c.archived = false AND c.type <> 'dm'
           AND (c.type <> 'private' OR cm.role IS NOT NULL)`,
        [req.user.sub, serverId],
      ),
      app.pg.query("SELECT * FROM agents WHERE server_id = $1", [serverId]),
      app.pg.query(
        `SELECT DISTINCT u.id, u.handle, u.display_name, u.avatar_url
         FROM users u
         JOIN channel_members cm ON cm.member_id = u.id AND cm.member_type = 'human'
         JOIN channels c ON c.id = cm.channel_id WHERE c.server_id = $1`,
        [serverId],
      ),
    ]);
    return { channels: channels.rows, agents: agents.rows, humans: humans.rows };
  });
}
