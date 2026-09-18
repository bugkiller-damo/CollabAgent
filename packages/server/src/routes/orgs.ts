import type { FastifyInstance } from "fastify";
import { getOrCreatePersonalOrg, isOrgOwner } from "../lib/orgs.js";
import { isServerMember, resolveTenant, UUID_RE } from "../lib/tenant.js";

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

  // ---- 创建 server（guild 化 B1）----
  // 用户主动建服：server + owner 成员 + general 频道 + 频道 owner 一个事务，
  // 任一步失败整体回滚，不留无频道/无成员的半截 server。personal=false——
  // 兜底个人空间由 getOrCreatePersonalOrg 负责，不走此端点。
  app.post("/orgs", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { name } = req.body || {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName) return reply.status(400).send({ error: "name required" });
    if (cleanName.length > 100) return reply.status(400).send({ error: "server name too long (max 100)" });
    const userId = String(req.user.sub);
    const org = await app.pg.transaction(async (tx) => {
      const s = await tx.query(
        `INSERT INTO servers (name, created_by, owner_id, personal) VALUES ($1, $2, $3, false) RETURNING id, name, personal, owner_id, created_at`,
        [cleanName, userId, userId],
      );
      const serverId = String(s.rows[0]!.id);
      await tx.query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')", [
        serverId,
        userId,
      ]);
      const ch = await tx.query(
        `INSERT INTO channels (server_id, name, description, type, created_by)
         VALUES ($1, 'general', 'General discussion', 'public', $2) RETURNING id`,
        [serverId, userId],
      );
      await tx.query(
        `INSERT INTO channel_members (channel_id, member_id, member_type, role)
         VALUES ($1, $2, 'human', 'owner')`,
        [ch.rows[0]!.id, userId],
      );
      return s.rows[0];
    });
    return { org: { ...org, role: "owner", memberCount: 1, agentCount: 0 } };
  });

  // ---- 改名（guild 化 B3；onboarding wizard 复用：ensure personal + PATCH 命名）----
  app.patch("/orgs/:serverId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can rename" });
    const { name } = req.body || {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName) return reply.status(400).send({ error: "name required" });
    if (cleanName.length > 100) return reply.status(400).send({ error: "server name too long (max 100)" });
    const r = await app.pg.query("UPDATE servers SET name = $2 WHERE id = $1 RETURNING id, name, personal, owner_id", [
      serverId,
      cleanName,
    ]);
    return { org: r.rows[0] };
  });

  // ---- 退出 server（guild 化 B4）----
  // owner 拒退（只能转让或删除——先保证每个 server 恒有 owner）；personal 拒退
  // （daemon/computer/POST /agents 的兜底落点，退出会留空挂点）。
  app.post("/orgs/:serverId/leave", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    const s = await app.pg.query<{ personal: boolean; owner_id: string | null }>(
      "SELECT personal, owner_id FROM servers WHERE id = $1",
      [serverId],
    );
    const srv = s.rows[0];
    if (!srv) return reply.status(404).send({ error: "server not found" });
    const me = await app.pg.query<{ role: string }>(
      "SELECT role FROM server_members WHERE server_id = $1 AND user_id::text = $2",
      [serverId, req.user.sub],
    );
    if (me.rows.length === 0) return reply.status(403).send({ error: "not a member" });
    if (srv.personal) return reply.status(409).send({ error: "cannot leave personal server" });
    if (me.rows[0]!.role === "owner" || String(srv.owner_id) === String(req.user.sub)) {
      return reply.status(409).send({ error: "owner must transfer or delete the server" });
    }
    await app.pg.query("DELETE FROM server_members WHERE server_id = $1 AND user_id::text = $2", [
      serverId,
      req.user.sub,
    ]);
    const { invalidateServerMembers } = await import("../lib/access.js");
    invalidateServerMembers(String(serverId));
    return { ok: true };
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
    const { invalidateServerMembers } = await import("../lib/access.js");
    invalidateServerMembers(String(serverId));
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
    const { invalidateServerMembers } = await import("../lib/access.js");
    invalidateServerMembers(String(serverId));
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
    // 可选鉴权：已登录且已是目标 server 成员 → alreadyMember 放行。
    // 受邀注册路径必经此处（register 事务已消费 invite + 入组）——max_uses=1 的
    // 邀请此时已耗尽，没有该短路 InviteAcceptPage 会误显「已达上限」。
    const serverId = String(r.rows[0].server_id);
    const { parseCookies, ACCESS_COOKIE } = await import("../lib/cookies.js");
    const { verifyBrowserToken } = await import("../lib/auth-token.js");
    const cookieTok = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
    if (cookieTok) {
      const me = await verifyBrowserToken(app.jwt.access, app.pg, cookieTok).catch(() => null);
      if (me) {
        const m = await app.pg.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2", [
          serverId,
          me.sub,
        ]);
        if (m.rows.length > 0) {
          return { valid: true, alreadyMember: true, serverId, serverName: inv.server_name };
        }
      }
    }
    if (inv.revoked_at) return reply.status(410).send({ error: "邀请链接已失效" });
    if (inv.expires_at && new Date(inv.expires_at) < new Date())
      return reply.status(410).send({ error: "邀请链接已过期" });
    if (inv.max_uses != null && inv.uses >= inv.max_uses)
      return reply.status(410).send({ error: "邀请链接使用次数已达上限" });
    // serverId 随校验结果返回：注册/登录后接邀请需要落到被邀 server 的 URL
    // （token 本身即能力凭证，id 非敏感信息）
    return { valid: true, serverId, serverName: inv.server_name };
  });

  // ---- 已登录接受邀请（guild 化 B2）----
  // 与 register 的 invite 消费同一「条件 UPDATE」口径（revoked/expires/max_uses
  // 全部入库判定，行锁串行后超额方 UPDATE 0 行自然失效），不开第二条
  // SELECT-then-UPDATE 路径。消费 + 入圈同一事务；已是成员幂等放行。
  app.post("/invites/:token/accept", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { token } = req.params;
    try {
      const joined = await app.pg.transaction(async (tx) => {
        // 已是该邀请目标 server 的成员 → 不消费 uses 直接放行（幂等）
        const target = await tx.query<{ server_id: string; server_name: string }>(
          `SELECT i.server_id, s.name AS server_name FROM invites i JOIN servers s ON s.id = i.server_id
            WHERE i.token = $1 AND i.revoked_at IS NULL`,
          [token],
        );
        const t = target.rows[0];
        if (t) {
          const m = await tx.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2", [
            t.server_id,
            req.user.sub,
          ]);
          if (m.rows.length > 0) return { ...t, role: "member", already: true };
        }
        const consumed = await tx.query<{ server_id: string; role: string; server_name: string }>(
          `UPDATE invites SET uses = uses + 1
             WHERE token = $1 AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())
               AND (max_uses IS NULL OR uses < max_uses)
             RETURNING server_id, role, (SELECT name FROM servers WHERE id = invites.server_id) AS server_name`,
          [token],
        );
        const inv = consumed.rows[0];
        if (!inv) return null;
        await tx.query(
          "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [inv.server_id, req.user.sub, inv.role],
        );
        return { ...inv, already: false };
      });
      if (!joined) {
        // 诊断 SELECT 仅为错误文案（原子消费已失败）：区分无效/吊销/过期/耗尽
        const d = await app.pg.query<{
          revoked_at: string | null;
          expires_at: string | null;
          max_uses: number | null;
          uses: number;
        }>("SELECT revoked_at, expires_at, max_uses, uses FROM invites WHERE token = $1", [token]);
        const inv = d.rows[0];
        if (!inv) return reply.status(404).send({ error: "邀请链接无效" });
        if (inv.revoked_at) return reply.status(410).send({ error: "邀请链接已失效" });
        if (inv.expires_at && new Date(inv.expires_at) < new Date())
          return reply.status(410).send({ error: "邀请链接已过期" });
        return reply.status(410).send({ error: "邀请链接使用次数已达上限" });
      }
      const { invalidateServerMembers } = await import("../lib/access.js");
      invalidateServerMembers(String(joined.server_id));
      return { ok: true, serverId: String(joined.server_id), serverName: joined.server_name };
    } catch (e) {
      // 并发注册/消费撞唯一约束时按幂等处理：已是成员则视为成功
      if ((e as { code?: string })?.code === "23505") return { ok: true };
      throw e;
    }
  });

  // ---- 工作区信息 ----
  app.get("/server/info", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    // O3：请求级租户解析（显式 serverId/x-server-id/Host 映射），替代全局默认 server；
    // 显式租户必须校验成员身份。单租户部署无显式声明时降级到默认 server，行为不变。
    const { serverId: serverIdParam } = (req.query as Record<string, string | undefined>) || {};
    const tenant = await resolveTenant(app, req, { serverId: serverIdParam });
    if (tenant.explicit && !(await isServerMember(app, tenant.serverId, req.user.sub))) {
      return reply.status(403).send({ error: "not a member of that server" });
    }
    const serverId = tenant.serverId;
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
    // O3：显式租户下 humans 只列该社区成员（防跨社区用户枚举）；单租户降级保留全员列表
    const humans = tenant.explicit
      ? await app.pg.query(
          `SELECT DISTINCT u.id, u.handle, u.display_name, u.avatar_url
             FROM users u JOIN server_members sm ON sm.user_id = u.id
            WHERE sm.server_id = $1 ORDER BY u.handle`,
          [serverId],
        )
      : await app.pg.query("SELECT id, handle, display_name, avatar_url FROM users ORDER BY handle");
    return {
      serverId,
      serverName: serverResult.rows[0]?.name,
      channels: channels.rows,
      agents: [],
      humans: humans.rows,
    };
  });
}
