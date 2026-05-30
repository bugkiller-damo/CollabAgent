import type { FastifyInstance } from "fastify";
import { canManageChannel, canAccessChannel } from "../lib/access.js";
import { resolvePeer, getOrCreateDmChannel, type Party } from "../lib/dm.js";
import { getDefaultServerId } from "../lib/server.js";

export async function channelRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req) => {
    const { serverId } = req.query as any;
    const resolvedServerId = serverId || (await getDefaultServerId(app));
    const result = await app.pg.query(
      `SELECT c.*, cm.role
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id::text = $1
       WHERE c.server_id = $2 AND c.archived = false AND c.type <> 'dm'
         AND (c.type <> 'private' OR cm.role IS NOT NULL)
       ORDER BY c.created_at`,
      [(req as any).user.sub, resolvedServerId]
    );
    return { channels: result.rows };
  });

  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId, name, description, type, visibility } = req.body as any;
    if (!name) return reply.status(400).send({ error: "name required" });
    const resolvedServerId = serverId || (await getDefaultServerId(app));
    if (!resolvedServerId) return reply.status(400).send({ error: "no server available" });
    const vis = visibility || type || "public";
    const userId = (req as any).user.sub;
    const exists = await app.pg.query(
      "SELECT 1 FROM channels WHERE server_id = $1 AND name = $2", [resolvedServerId, name]
    );
    if (exists.rows.length > 0) return reply.status(409).send({ error: "channel already exists" });
    const result = await app.pg.query(
      `INSERT INTO channels (server_id, name, description, type, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [resolvedServerId, name, description || null, vis, userId]
    );
    const channel = result.rows[0];
    // 创建者自动成为频道 owner
    await app.pg.query(
      `INSERT INTO channel_members (channel_id, member_id, member_type, role)
       VALUES ($1, $2, 'human', 'owner') ON CONFLICT DO NOTHING`,
      [channel.id, userId]
    );
    return { channel };
  });

  app.patch("/:channelId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as any;
    if (!(await canManageChannel(app, channelId, (req as any).user.sub))) {
      return reply.status(403).send({ error: "only channel admins can modify this channel" });
    }
    const { description, type, visibility, archived } = req.body as any;
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (description !== undefined) { sets.push(`description = $${p++}`); params.push(description || null); }
    const vis = visibility ?? type;
    if (vis !== undefined) { sets.push(`type = $${p++}`); params.push(vis); }
    if (archived !== undefined) { sets.push(`archived = $${p++}`); params.push(!!archived); }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields to update" });
    sets.push(`updated_at = now()`);
    params.push(channelId);
    const result = await app.pg.query(
      `UPDATE channels SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    return { channel: result.rows[0] };
  });

  app.get("/:channelId/members", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as any;
    if (!(await canAccessChannel(app, channelId, (req as any).user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const result = await app.pg.query(
      `SELECT cm.member_id, cm.member_type, cm.role, cm.joined_at,
              COALESCE(u.handle, a.name) as handle,
              COALESCE(u.display_name, a.display_name) as display_name
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
       WHERE cm.channel_id = $1`,
      [channelId]
    );
    return { members: result.rows };
  });

  app.post("/:channelId/join", { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as any;
    const { memberType } = req.body as any;
    await app.pg.query(
      `INSERT INTO channel_members (channel_id, member_id, member_type)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [channelId, (req as any).user.sub, memberType || "human"]
    );
    return { ok: true };
  });

  app.post("/:channelId/leave", { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as any;
    await app.pg.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2`,
      [channelId, (req as any).user.sub]
    );
    return { ok: true };
  });

  // 邀请成员：按 handle 查找用户或 agent 并加入频道
  app.post("/:channelId/invite", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as any;
    if (!(await canManageChannel(app, channelId, (req as any).user.sub))) {
      return reply.status(403).send({ error: "only channel admins can invite members" });
    }
    const { handle } = req.body as any;
    if (!handle) return reply.status(400).send({ error: "handle required" });
    const clean = handle.replace(/^@/, "");
    // 先找用户，找不到再找 agent
    const user = await app.pg.query("SELECT id FROM users WHERE handle = $1", [clean]);
    let memberId: string | null = null;
    let memberType: "human" | "agent" | null = null;
    if (user.rows.length > 0) {
      memberId = String((user.rows[0] as any).id); memberType = "human";
    } else {
      const ch = await app.pg.query("SELECT server_id FROM channels WHERE id = $1", [channelId]);
      const agent = await app.pg.query(
        "SELECT id FROM agents WHERE name = $1 AND server_id = $2",
        [clean, (ch.rows[0] as any)?.server_id]
      );
      if (agent.rows.length > 0) { memberId = String((agent.rows[0] as any).id); memberType = "agent"; }
    }
    if (!memberId || !memberType) return reply.status(404).send({ error: "user or agent not found" });
    const exists = await app.pg.query(
      "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = $3",
      [channelId, memberId, memberType]
    );
    if (exists.rows.length > 0) return reply.status(409).send({ error: "already a member" });
    await app.pg.query(
      `INSERT INTO channel_members (channel_id, member_id, member_type, role)
       VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`,
      [channelId, memberId, memberType]
    );
    return { ok: true, memberType };
  });

  // 移除成员
  app.delete("/:channelId/members/:memberId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, memberId } = req.params as any;
    const userId = (req as any).user.sub;
    // 允许管理员移除他人，或成员主动退出
    if (memberId !== userId && !(await canManageChannel(app, channelId, userId))) {
      return reply.status(403).send({ error: "only channel admins can remove members" });
    }
    await app.pg.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2`,
      [channelId, memberId]
    );
    return { ok: true };
  });

  // 角色分配：管理员 / 普通成员
  app.patch("/:channelId/members/:memberId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, memberId } = req.params as any;
    if (!(await canManageChannel(app, channelId, (req as any).user.sub))) {
      return reply.status(403).send({ error: "only channel admins can change roles" });
    }
    const { role } = req.body as any;
    if (!["admin", "member", "owner"].includes(role)) {
      return reply.status(400).send({ error: "invalid role" });
    }
    await app.pg.query(
      `UPDATE channel_members SET role = $1 WHERE channel_id = $2 AND member_id = $3`,
      [role, channelId, memberId]
    );
    return { ok: true };
  });

  // 删除频道（连带成员与消息）
  app.delete("/:channelId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as any;
    if (!(await canManageChannel(app, channelId, (req as any).user.sub))) {
      return reply.status(403).send({ error: "only channel admins can delete this channel" });
    }
    const ch = await app.pg.query("SELECT id FROM channels WHERE id = $1", [channelId]);
    if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    await app.pg.query(
      "DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)", [channelId]
    );
    await app.pg.query(
      "DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)", [channelId]
    );
    await app.pg.query("DELETE FROM action_cards WHERE channel_id = $1", [channelId]);
    await app.pg.query("DELETE FROM messages WHERE channel_id = $1", [channelId]);
    await app.pg.query("DELETE FROM channel_members WHERE channel_id = $1", [channelId]);
    await app.pg.query("DELETE FROM channels WHERE id = $1", [channelId]);
    return { ok: true };
  });

  app.get("/resolve", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target } = req.query as any;
    if (!target) return reply.status(400).send({ error: "target required" });
    if (target.startsWith("dm:@")) {
      const userId = (req as any).user.sub;
      const peer = await resolvePeer(app, target.slice(3).split(":")[0]);
      if (!peer) return reply.status(404).send({ error: "peer not found" });
      const me: Party = { id: userId, type: "human", handle: (req as any).user.handle };
      const channelId = await getOrCreateDmChannel(app, me, peer);
      // dmKey：浏览器侧统一会话键，与 WS 投递 channelId 一致
      return { type: "dm", channelId, dmKey: "dm:" + channelId, peer };
    }
    const name = target.startsWith("#") ? target.slice(1).split(":")[0] : target;
    const result = await app.pg.query("SELECT * FROM channels WHERE name = $1", [name]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    return { type: "channel", ...result.rows[0] };
  });

  // 我的 DM 会话列表（含对端信息与最近一条消息）
  app.get("/dms", { preHandler: [app.authenticate] }, async (req) => {
    const userId = (req as any).user.sub;
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
      [userId]
    );
    return { dms: r.rows };
  });

  app.get("/server", { preHandler: [app.authenticate] }, async (req) => {
    const { serverId } = req.query as any;
    const [channels, agents, humans] = await Promise.all([
      app.pg.query(
        `SELECT c.*, cm.role
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1
         WHERE c.server_id = $2 AND c.archived = false AND c.type <> 'dm'`,
        [(req as any).user.sub, serverId]
      ),
      app.pg.query("SELECT * FROM agents WHERE server_id = $1", [serverId]),
      app.pg.query(
        `SELECT DISTINCT u.id, u.handle, u.display_name, u.avatar_url
         FROM users u
         JOIN channel_members cm ON cm.member_id = u.id AND cm.member_type = 'human'
         JOIN channels c ON c.id = cm.channel_id WHERE c.server_id = $1`,
        [serverId]
      ),
    ]);
    return { channels: channels.rows, agents: agents.rows, humans: humans.rows };
  });
}
