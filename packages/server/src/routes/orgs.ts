import type { FastifyInstance } from "fastify";
import { isInstanceAdmin, isOrgOwner } from "../lib/orgs.js";
import { isServerMember, resolveTenant, UUID_RE } from "../lib/tenant.js";

export async function orgRoutes(app: FastifyInstance) {
  // ---- 组织列表 ----
  // 2026-09-19 personal 特例取消：不再懒建个人空间——注册自动入圈广场（auth.ts），
  // 想要自己的 server 走 POST /orgs 或 discover/join。
  app.get("/orgs", { preHandler: [app.authenticate] }, async (req: any) => {
    const r = await app.pg.query(
      `SELECT s.id, s.name, s.is_public, s.owner_id, sm.role,
              (SELECT count(*)::int FROM server_members WHERE server_id = s.id) as "memberCount",
              (SELECT count(*)::int FROM agents WHERE server_id = s.id) as "agentCount",
              (s.id = COALESCE(
                (SELECT id FROM servers WHERE is_public = true ORDER BY created_at ASC LIMIT 1),
                (SELECT id FROM servers ORDER BY created_at ASC LIMIT 1))) as "isDefault"
         FROM server_members sm JOIN servers s ON s.id = sm.server_id
        WHERE sm.user_id::text = $1
        ORDER BY s.created_at ASC`,
      [req.user.sub],
    );
    return { orgs: r.rows };
  });

  // ---- 公共 server 发现面 ----
  // is_public server 对未加入的登录用户可见——注册自动入圈只覆盖 2026-09-17
  // 之后的新账号，存量未入圈用户靠此卡片 + POST /orgs/:id/join 自助补票。
  // 只回未加入的（已加入的走 GET /orgs）。
  app.get("/orgs/discover", { preHandler: [app.authenticate] }, async (req: any) => {
    const r = await app.pg.query(
      `SELECT s.id, s.name, s.is_public,
              (SELECT count(*)::int FROM server_members WHERE server_id = s.id) as "memberCount",
              (SELECT count(*)::int FROM agents WHERE server_id = s.id) as "agentCount",
              (s.id = COALESCE(
                (SELECT id FROM servers WHERE is_public = true ORDER BY created_at ASC LIMIT 1),
                (SELECT id FROM servers ORDER BY created_at ASC LIMIT 1))) as "isDefault"
         FROM servers s
        WHERE s.is_public = true
          AND NOT EXISTS (SELECT 1 FROM server_members sm WHERE sm.server_id = s.id AND sm.user_id::text = $1)
        ORDER BY s.created_at ASC`,
      [req.user.sub],
    );
    return { servers: r.rows };
  });

  // ---- 创建 server（guild 化 B1）----
  // 用户主动建服：server + owner 成员 + 私有 onboarding-owner 频道 + 频道 owner
  // 一个事务，任一步失败整体回滚，不留无频道/无成员的半截 server。
  // onboarding-owner（type='private'）是 owner 的私有引导频道——之后邀请进来
  // 的成员看不到它，团队频道由 owner 另建。
  app.post("/orgs", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { name } = req.body || {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName) return reply.status(400).send({ error: "name required" });
    if (cleanName.length > 100) return reply.status(400).send({ error: "server name too long (max 100)" });
    const userId = String(req.user.sub);
    const org = await app.pg.transaction(async (tx) => {
      const s = await tx.query(
        `INSERT INTO servers (name, created_by, owner_id) VALUES ($1, $2, $3) RETURNING id, name, owner_id, created_at`,
        [cleanName, userId, userId],
      );
      const serverId = String(s.rows[0]!.id);
      await tx.query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')", [
        serverId,
        userId,
      ]);
      const ch = await tx.query(
        `INSERT INTO channels (server_id, name, type, created_by)
         VALUES ($1, 'onboarding-owner', 'private', $2) RETURNING id`,
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

  // ---- 改名 / 可见性（guild 化 B3；2026-09-18：is_public 翻转走实例管理员门禁 §9.2）----
  // name 与 isPublic 可独立或同传。isPublic 存在时整请求收敛为 isInstanceAdmin
  // 口径（owner 仅可改名，不可自助改可见性）；isPublic 不存在时维持 owner-only。
  app.patch("/orgs/:serverId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    const { name, isPublic } = req.body || {};
    if (isPublic !== undefined) {
      if (typeof isPublic !== "boolean") return reply.status(400).send({ error: "isPublic must be boolean" });
      if (!(await isInstanceAdmin(app, req.user.sub)))
        return reply.status(403).send({ error: "only instance admin can change visibility" });
    } else if (!(await isOrgOwner(app, serverId, req.user.sub))) {
      return reply.status(403).send({ error: "only org owner can rename" });
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (name !== undefined) {
      const cleanName = typeof name === "string" ? name.trim() : "";
      if (!cleanName) return reply.status(400).send({ error: "name required" });
      if (cleanName.length > 100) return reply.status(400).send({ error: "server name too long (max 100)" });
      vals.push(cleanName);
      sets.push(`name = $${vals.length + 1}`);
    }
    if (isPublic !== undefined) {
      vals.push(isPublic);
      sets.push(`is_public = $${vals.length + 1}`);
    }
    if (sets.length === 0) return reply.status(400).send({ error: "name required" });
    const r = await app.pg.query(
      `UPDATE servers SET ${sets.join(", ")} WHERE id = $1 RETURNING id, name, is_public, owner_id`,
      [serverId, ...vals],
    );
    if (isPublic !== undefined) {
      // is_public 翻转可改变默认社区归属——清 getDefaultServerId 的 60s 缓存
      const { clearDefaultServerCache } = await import("../lib/server.js");
      clearDefaultServerCache();
    }
    return { org: r.rows[0] };
  });

  // ---- 退出 server（guild 化 B4）----
  // owner 拒退（只能转让或删除——先保证每个 server 恒有 owner）。member 可退任意
  // server（§4 表）：含 personal 与 is_public 广场——发现面落地后退出广场不再
  // 失联，卡片回 discover 可随时再加入（2026-09-19 放开，原 §9.3 拒退废除）。
  app.post("/orgs/:serverId/leave", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    const s = await app.pg.query<{ owner_id: string | null }>("SELECT owner_id FROM servers WHERE id = $1", [serverId]);
    const srv = s.rows[0];
    if (!srv) return reply.status(404).send({ error: "server not found" });
    const me = await app.pg.query<{ role: string }>(
      "SELECT role FROM server_members WHERE server_id = $1 AND user_id::text = $2",
      [serverId, req.user.sub],
    );
    if (me.rows.length === 0) return reply.status(403).send({ error: "not a member" });
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

  // ---- 自助加入公共 server（2026-09-18 权限模型）----
  // is_public=true 的广场对已登录用户开放：无需邀请。private server 一律走
  // 邀请/直拉（403 invite required）。幂等：已是成员按成功返回 alreadyMember。
  app.post("/orgs/:serverId/join", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    const s = await app.pg.query<{ is_public: boolean }>("SELECT is_public FROM servers WHERE id = $1", [serverId]);
    const srv = s.rows[0];
    if (!srv) return reply.status(404).send({ error: "server not found" });
    if (!srv.is_public) return reply.status(403).send({ error: "invite required" });
    const me = await app.pg.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2", [
      serverId,
      req.user.sub,
    ]);
    if (me.rows.length > 0) return { ok: true, alreadyMember: true };
    await app.pg.query(
      "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [serverId, req.user.sub],
    );
    const { invalidateServerMembers } = await import("../lib/access.js");
    invalidateServerMembers(String(serverId));
    return { ok: true };
  });

  // ---- 删除 server（guild 化 B5；2026-09-19 服务器资料页：agent 一并级联）----
  // 级联范围（事务内，依赖序）：
  //   computers / machine_tokens —— server 级设施随服级联（B5，2026-09-19）；
  //   messages —— server_id ∪ 本 server 频道双口径（防 channel 归属不一致残留）；
  //     reactions/attachments 映射/edits/task_events/task_comments 随 FK CASCADE。
  //   attachments 孤儿行 —— 与频道删除同语义：先删行（RETURNING storage_key），
  //     提交后 best-effort 清对象字节。
  //   action_cards —— 无 CASCADE，显式删。
  //   channels —— channel_members / dispatches 随 FK CASCADE（dispatches 另有
  //     agents FK，必须先于 agents 删除）。
  //   agents —— agent_credentials / agent_logins 无 CASCADE 显式删；
  //     agent_cost_daily 随 FK CASCADE。
  //   server_members / invites / servers。
  //   notifications / reminders / events 无 FK——按审计留痕口径保留悬空引用。
  // 默认社区拒删由 getDefaultServerId 的 is_public 优先语义承载——公共 server 恒拒删。
  app.delete("/orgs/:serverId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    const s = await app.pg.query<{ owner_id: string | null }>("SELECT owner_id FROM servers WHERE id = $1", [serverId]);
    const srv = s.rows[0];
    if (!srv) return reply.status(404).send({ error: "server not found" });
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can delete the server" });
    const { getDefaultServerId } = await import("../lib/server.js");
    if ((await getDefaultServerId(app)) === String(serverId))
      return reply.status(409).send({ error: "cannot delete the default server" });
    let result: { channelIds: string[]; removedKeys: string[] };
    try {
      result = await app.pg.transaction(async (tx) => {
        // 2026-09-19 server-scoped computers（B5）：计算机行与机器令牌都属于 server——
        // 删服即级联，不再重指到 personal（重指会让别的 server 凭空多出从未注册的
        // 机器行，违反「daemon 跑起来才写库」的语义）。机器上的 daemon 下次握手会因
        // token 行消失/scope 失效被拒，自然离线。
        // 先解绑：跨 server 引用仍存在——曾被踢出/迁移到他 server 的 agent 可能
        // 仍指向这里的计算机，置 NULL 待就位（本 server 的 agent 反正随后级联删除）。
        await tx.query(
          "UPDATE agents SET computer_id = NULL WHERE computer_id IN (SELECT id FROM computers WHERE server_id = $1)",
          [serverId],
        );
        await tx.query("DELETE FROM computers WHERE server_id = $1", [serverId]);
        await tx.query("DELETE FROM machine_tokens WHERE server_id = $1", [serverId]);
        // 附件行/字节收集（同频道删除语义）：先收 id，删行后事务外清字节
        const linked = await tx.query<{ attachment_id: string }>(
          `SELECT DISTINCT attachment_id FROM message_attachments
            WHERE message_id IN (
              SELECT id FROM messages
               WHERE server_id = $1 OR channel_id IN (SELECT id FROM channels WHERE server_id = $1))`,
          [serverId],
        );
        const attachmentIds = linked.rows.map((r) => String(r.attachment_id));
        await tx.query(
          `DELETE FROM messages
            WHERE server_id = $1 OR channel_id IN (SELECT id FROM channels WHERE server_id = $1)`,
          [serverId],
        );
        let removedKeys: string[] = [];
        if (attachmentIds.length > 0) {
          const removed = await tx.query<{ storage_key: string }>(
            `DELETE FROM attachments
              WHERE id = ANY($1) AND NOT EXISTS (
                SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = attachments.id)
              RETURNING storage_key`,
            [attachmentIds],
          );
          removedKeys = removed.rows.map((r) => r.storage_key);
        }
        await tx.query("DELETE FROM action_cards WHERE channel_id IN (SELECT id FROM channels WHERE server_id = $1)", [
          serverId,
        ]);
        const chans = await tx.query<{ id: string }>("DELETE FROM channels WHERE server_id = $1 RETURNING id", [
          serverId,
        ]);
        // agents 级联（2026-09-19 服务器资料页：删服即删全部数据）——须在 channels
        // 之后：dispatches.channel_id 随频道 CASCADE 先清，否则 agents FK 拦截。
        // agent_credentials / agent_logins 无 CASCADE 显式删；agent_cost_daily
        // 随 FK CASCADE。
        await tx.query("DELETE FROM agent_credentials WHERE agent_id IN (SELECT id FROM agents WHERE server_id = $1)", [
          serverId,
        ]);
        await tx.query("DELETE FROM agent_logins WHERE agent_id IN (SELECT id FROM agents WHERE server_id = $1)", [
          serverId,
        ]);
        await tx.query("DELETE FROM agents WHERE server_id = $1", [serverId]);
        await tx.query("DELETE FROM server_members WHERE server_id = $1", [serverId]);
        await tx.query("DELETE FROM invites WHERE server_id = $1", [serverId]);
        await tx.query("DELETE FROM servers WHERE id = $1", [serverId]);
        return { channelIds: chans.rows.map((r) => String(r.id)), removedKeys };
      });
    } catch (e) {
      // 残余竞态窗（级联删 agents 后、删 servers 前 agent 插入提交）→ FK 23503
      // → 409 让客户端重试；此刻事务已回滚，server 原样保留
      if ((e as { code?: string })?.code === "23503")
        return reply.status(409).send({ error: "server busy, please retry" });
      throw e;
    }
    const { invalidateChannel, invalidateMember, invalidateServerMembers } = await import("../lib/access.js");
    const { removeUnreferencedAttachmentKeys } = await import("../lib/attachment-gc.js");
    invalidateServerMembers(String(serverId));
    for (const cid of result.channelIds) {
      invalidateChannel(cid);
      invalidateMember(cid);
    }
    await removeUnreferencedAttachmentKeys(app, result.removedKeys);
    return { ok: true };
  });

  // ---- 移出 agent（2026-09-18 权限模型 §9.1；2026-09-19 取消兜底空间后改口径）----
  // owner 把别人的 agent 踢出本 server：弹出而非销毁——agent 本体保留，
  // server_id 重指 agent 属主（agent.user_id，非请求者）最早拥有的 server，
  // 优先落在有其计算机行的 server（agent 落地即可跑）；绑定机留在被踢 server，
  // 跨 server 绑定非法——computer_id 随之清空，目标 server 恰一台属主机时
  // 自动重绑（与 POST /agents 单机自动绑定同口径）。属主无任何拥有的
  // server → 409，踢不出。
  app.delete("/orgs/:serverId/agents/:agentId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId, agentId } = req.params;
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    if (!UUID_RE.test(String(agentId))) return reply.status(400).send({ error: "invalid agentId" });
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can remove agents" });
    const ag = await app.pg.query<{ user_id: string }>("SELECT user_id FROM agents WHERE id = $1 AND server_id = $2", [
      agentId,
      serverId,
    ]);
    const agent = ag.rows[0];
    if (!agent) return reply.status(404).send({ error: "agent not found in this server" });
    // 重指属主最早拥有的 server：优先有计算机行的（按 server 创建序），保证
    // 被踢 agent 落地即可跑；都没有则最早拥有的 server（agent 未就位）。
    // personal/is_public 均不排除——所有 server 同口径（2026-09-19 特例取消）。
    const home = await app.pg.query<{ server_id: string }>(
      `SELECT s.id AS server_id FROM servers s
         JOIN server_members sm ON sm.server_id = s.id AND sm.role = 'owner'
        WHERE sm.user_id::text = $1 AND s.id <> $2
        ORDER BY (SELECT count(*) FROM computers c WHERE c.server_id = s.id AND c.user_id::text = $1) DESC,
                 s.created_at ASC
        LIMIT 1`,
      [agent.user_id, serverId],
    );
    const homeId = home.rows[0] ? String(home.rows[0].server_id) : null;
    if (!homeId)
      return reply.status(409).send({ error: "agent owner has no server to receive it (kicked agent needs a home)" });
    // 目标 server 内属主计算机恰一台 → 自动重绑；否则解绑待就位
    const machines = await app.pg.query<{ id: string }>(
      "SELECT id FROM computers WHERE user_id::text = $1 AND server_id = $2 ORDER BY last_ready_at DESC NULLS LAST, created_at ASC",
      [agent.user_id, homeId],
    );
    const bindId = machines.rows.length === 1 ? String(machines.rows[0]!.id) : null;
    try {
      await app.pg.query("UPDATE agents SET server_id = $2, computer_id = $3 WHERE id = $1", [agentId, homeId, bindId]);
    } catch (e) {
      // 目标空间已存在同名 agent（agents 有 (server_id, lower(name)) 唯一索引）
      if ((e as { code?: string })?.code === "23505")
        return reply.status(409).send({ error: "agent name conflicts in owner's home server" });
      throw e;
    }
    const removed = await app.pg.query<{ channel_id: string }>(
      `DELETE FROM channel_members
        WHERE member_id = $1 AND member_type = 'agent'
          AND channel_id IN (SELECT id FROM channels WHERE server_id = $2)
        RETURNING channel_id`,
      [agentId, serverId],
    );
    if (removed.rows.length > 0) {
      const { invalidateMember } = await import("../lib/access.js");
      for (const row of removed.rows) invalidateMember(String(row.channel_id), String(agentId));
    }
    return { ok: true };
  });

  // ---- 转让 owner（guild 化 B6）----
  // owner 限定；目标须为该 server 成员。事务内三步：目标升 owner（RETURNING
  // 复检——SELECT 与 UPDATE 之间被移出的竞态会让 promote 命中 0 行，整体回滚
  // 不致把 server 转给非成员）→ servers.owner_id 换指 → 我降到目标旧角色
  // （role 互换；若我本就无 owner 成员行 demote 命中 0 行也无碍——owner_id
  // 直判路径不受影响）。
  // 默认社区可转——这是实例管理员（广场 owner）和平交接的唯一路径。
  app.post("/orgs/:serverId/transfer", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { serverId } = req.params;
    const { userId } = req.body || {};
    if (!UUID_RE.test(String(serverId))) return reply.status(400).send({ error: "invalid serverId" });
    if (!UUID_RE.test(String(userId))) return reply.status(400).send({ error: "invalid userId" });
    if (String(userId) === String(req.user.sub))
      return reply.status(400).send({ error: "target is already the owner" });
    const s = await app.pg.query<{ id: string }>("SELECT id FROM servers WHERE id = $1", [serverId]);
    const srv = s.rows[0];
    if (!srv) return reply.status(404).send({ error: "server not found" });
    if (!(await isOrgOwner(app, serverId, req.user.sub)))
      return reply.status(403).send({ error: "only org owner can transfer ownership" });
    const r = await app.pg.transaction(async (tx) => {
      const target = await tx.query<{ role: string }>(
        "SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2",
        [serverId, String(userId)],
      );
      const t = target.rows[0];
      if (!t) return { error: "target" as const };
      const promote = await tx.query(
        "UPDATE server_members SET role = 'owner' WHERE server_id = $1 AND user_id = $2 RETURNING user_id",
        [serverId, String(userId)],
      );
      if (promote.rows.length === 0) return { error: "target" as const };
      await tx.query("UPDATE servers SET owner_id = $2 WHERE id = $1", [serverId, String(userId)]);
      // 目标旧角色为 owner（多 owner 脏数据）时钳到 member——转让必须收敛回单 owner
      const demoteRole = t.role === "owner" ? "member" : t.role;
      await tx.query("UPDATE server_members SET role = $3 WHERE server_id = $1 AND user_id = $2 AND role = 'owner'", [
        serverId,
        req.user.sub,
        demoteRole,
      ]);
      return { error: null };
    });
    if (r.error === "target") return reply.status(400).send({ error: "target must be a server member" });
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
      `SELECT sm.user_id, sm.role, u.handle, u.display_name, u.avatar_url
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
      `SELECT DISTINCT ON (c.id) c.*, cm.role, (cm.member_id IS NOT NULL) AS joined
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
