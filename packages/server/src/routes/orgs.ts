import type { FastifyInstance } from "fastify";
import { getOrCreatePersonalOrg, isOrgOwner } from "../lib/orgs.js";

export async function orgRoutes(app: FastifyInstance) {
  // ---- 组织列表 ----
  app.get("/orgs", { preHandler: [app.authenticate] }, async (req: any) => {
    try {
      await getOrCreatePersonalOrg(app, req.user.sub, req.user.handle);
    } catch {
      /* ignore */
    }
    const r = await app.pg.query(
      `SELECT s.id, s.name, s.personal, s.owner_id, sm.role,
              (SELECT count(*)::int FROM server_members WHERE server_id = s.id) as "memberCount",
              (SELECT count(*)::int FROM agents WHERE server_id = s.id) as "agentCount"
         FROM server_members sm JOIN servers s ON s.id = sm.server_id
        WHERE sm.user_id::text = $1
        ORDER BY s.personal DESC, s.created_at ASC`,
      [req.user.sub],
    );
    return { orgs: r.rows };
  });

  // ---- 成员管理 ----
  app.get("/orgs/:serverId/members", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    const me = await app.pg.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2", [
      serverId,
      req.user.sub,
    ]);
    if (me.rows.length === 0) return reply.status(403).send({ error: "not a member" });
    const r = await app.pg.query(
      `SELECT sm.user_id, sm.role, u.handle, u.display_name
         FROM server_members sm JOIN users u ON u.id = sm.user_id
        WHERE sm.server_id = $1 ORDER BY sm.role DESC, u.handle`,
      [serverId],
    );
    return { members: r.rows };
  });

  app.post("/orgs/:serverId/members", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    const { handle } = req.body || {};
    if (!handle) return reply.status(400).send({ error: "handle required" });
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can invite" });
    const u = await app.pg.query<{ id: string }>("SELECT id FROM users WHERE handle = $1", [
      String(handle).replace(/^@/, ""),
    ]);
    if (u.rows.length === 0) return reply.status(404).send({ error: "user not found" });
    await app.pg.query(
      "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [serverId, u.rows[0]!.id],
    );
    return { ok: true };
  });

  app.delete("/orgs/:serverId/members/:userId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId, userId } = req.params;
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can remove" });
    await app.pg.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2 AND role <> 'owner'", [
      serverId,
      userId,
    ]);
    return { ok: true };
  });

  app.patch("/orgs/:serverId/members/:userId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId, userId } = req.params;
    const { role } = req.body || {};
    if (!["member", "admin"].includes(role)) return reply.status(400).send({ error: "role must be member or admin" });
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can change roles" });
    await app.pg.query(
      "UPDATE server_members SET role = $3 WHERE server_id = $1 AND user_id = $2 AND role <> 'owner'",
      [serverId, userId, role],
    );
    return { ok: true };
  });

  // ---- 邀请链接 ----
  app.get("/orgs/:serverId/invites", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can manage invites" });
    const r = await app.pg.query(
      `SELECT token, role, max_uses, uses, expires_at, revoked_at, created_at FROM invites WHERE server_id = $1 ORDER BY created_at DESC`,
      [serverId],
    );
    return { invites: r.rows };
  });

  app.post("/orgs/:serverId/invites", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can invite" });
    const { maxUses, expiresInDays } = req.body || {};
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(24).toString("base64url");
    const expiresAt = expiresInDays ? new Date(Date.now() + Number(expiresInDays) * 86400000).toISOString() : null;
    await app.pg.query(
      `INSERT INTO invites (token, server_id, created_by, role, max_uses, expires_at) VALUES ($1, $2, $3, 'member', $4, $5)`,
      [token, serverId, req.user.sub, maxUses ? Number(maxUses) : null, expiresAt],
    );
    return { token };
  });

  app.delete("/orgs/:serverId/invites/:token", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId, token } = req.params;
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can revoke" });
    await app.pg.query("UPDATE invites SET revoked_at = now() WHERE server_id = $1 AND token = $2", [serverId, token]);
    return { ok: true };
  });

  // ---- 公开邀请校验 ----
  app.get("/invites/:token", async (req: any, reply: any) => {
    const { token } = req.params;
    const r = await app.pg.query(
      `SELECT i.server_id, i.role, i.max_uses, i.uses, i.expires_at, i.revoked_at, s.name AS server_name
         FROM invites i JOIN servers s ON s.id = i.server_id WHERE i.token = $1`,
      [token],
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "邀请链接无效" });
    const inv = r.rows[0] as {
      revoked_at: string | null;
      expires_at: string | null;
      max_uses: number | null;
      uses: number;
      server_name: string;
    };
    if (inv.revoked_at) return reply.status(410).send({ error: "邀请链接已失效" });
    if (inv.expires_at && new Date(inv.expires_at) < new Date())
      return reply.status(410).send({ error: "邀请链接已过期" });
    if (inv.max_uses != null && inv.uses >= inv.max_uses)
      return reply.status(410).send({ error: "邀请链接使用次数已达上限" });
    return { valid: true, serverName: inv.server_name };
  });

  // ---- 工作区信息 ----
  app.get("/server/info", { preHandler: [app.authenticate] }, async (req: any) => {
    const { getDefaultServerId } = await import("../lib/server.js");
    const serverId = await getDefaultServerId(app);
    if (!serverId) return { channels: [], agents: [], humans: [] };
    const serverResult = await app.pg.query<{ name: string }>("SELECT id, name FROM servers WHERE id = $1", [serverId]);
    const userId = req.user?.sub;
    const channels = await app.pg.query(
      `SELECT DISTINCT ON (c.id) c.*, cm.role
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id::text = $2 AND cm.member_type = 'human'
        WHERE c.server_id = $1 AND c.archived = false AND c.type <> 'dm'
          AND (c.type <> 'private' OR cm.role IS NOT NULL)`,
      [serverId, userId],
    );
    const humans = await app.pg.query("SELECT id, handle, display_name, avatar_url FROM users ORDER BY handle");
    return {
      serverId,
      serverName: serverResult.rows[0]?.name,
      channels: channels.rows,
      agents: [],
      humans: humans.rows,
    };
  });
}
