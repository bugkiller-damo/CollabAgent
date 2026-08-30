import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { clearAuthCookies } from "../lib/cookies.js";
import { validatePassword } from "../lib/validators.js";

export async function profileRoutes(app: FastifyInstance) {
  // ===== 基本资料 =====

  // GET /api/profile — 查资料（目标 handle/id 或自己的）
  app.get("/", { preHandler: [app.authenticate] }, async (req) => {
    const { target } = req.query as Record<string, string>;
    const id = target || req.user.sub;
    const result = await app.pg.query(
      "SELECT id, handle, display_name, description, avatar_url, created_at FROM users WHERE handle = $1 OR id = $2",
      [target, id],
    );
    if (result.rows.length === 0) return { error: "not found" };
    return result.rows[0];
  });

  // PATCH /api/profile — 更新资料（合并 avatarUrl 支持）
  app.patch("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { displayName, description, avatarUrl } = req.body as Record<string, unknown>;
    const userId = req.user.sub;
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (displayName) {
      sets.push("display_name = $" + p++);
      params.push(displayName);
    }
    if (description !== undefined) {
      sets.push("description = $" + p++);
      params.push(description);
    }
    if (avatarUrl) {
      sets.push("avatar_url = $" + p++);
      params.push(avatarUrl);
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields to update" });
    params.push(userId);
    const result = await app.pg.query(
      "UPDATE users SET " +
        sets.join(", ") +
        ", updated_at = now() WHERE id = $" +
        p +
        " RETURNING id, handle, display_name, description, avatar_url, email",
      params,
    );
    const u = result.rows[0] as Record<string, unknown>;
    return {
      user: {
        id: u.id,
        handle: u.handle,
        displayName: u.display_name,
        description: u.description,
        avatarUrl: u.avatar_url,
        email: u.email,
      },
    };
  });

  // ===== 密码管理 =====

  // POST /api/profile/change-password
  app.post("/change-password", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { oldPassword, newPassword } = req.body as Record<string, unknown>;
    if (!oldPassword || !newPassword) return reply.status(400).send({ error: "请输入旧密码和新密码" });
    const pwErr = validatePassword(newPassword as string);
    if (pwErr) return reply.status(400).send({ error: pwErr });

    const user = await app.pg.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
      req.user.sub,
    ]);
    if (!(await bcrypt.compare(oldPassword as string, user.rows[0]!.password_hash))) {
      return reply.status(401).send({ error: "旧密码不正确" });
    }
    const hash = await bcrypt.hash(newPassword as string, 12);
    await app.pg.query(
      "UPDATE users SET password_hash = $1, token_version = gen_random_uuid()::text, updated_at = now() WHERE id = $2",
      [hash, req.user.sub],
    );
    // token_version 已滚动 → 让会话校验缓存立即失效，旧 access token 即刻不可用
    const { clearSessionCache } = await import("../lib/session-check.js");
    clearSessionCache();
    return { ok: true };
  });

  // ===== 当前用户 =====

  // GET /api/profile/me
  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const result = await app.pg.query(
      "SELECT id, handle, display_name, description, avatar_url, email FROM users WHERE id = $1",
      [req.user.sub],
    );
    return { user: result.rows[0] };
  });

  // ===== 数据导出 =====

  // GET /api/profile/export
  app.get("/export", { preHandler: [app.authenticate] }, async (req) => {
    const userId = req.user.sub;
    const [profile, messages, memberships, reminders, sessions] = await Promise.all([
      app.pg.query(
        "SELECT id, handle, display_name, email, description, avatar_url, created_at FROM users WHERE id = $1",
        [userId],
      ),
      app.pg.query(
        "SELECT id, channel_id, content, created_at FROM messages WHERE sender_id = $1 ORDER BY created_at",
        [userId],
      ),
      app.pg.query(
        "SELECT cm.channel_id, c.name as channel_name, cm.role, cm.joined_at FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE cm.member_id = $1 AND cm.member_type = 'human'",
        [userId],
      ),
      app.pg.query(
        "SELECT id, title, fire_at, repeat_rule, status, created_at FROM reminders WHERE owner_id = $1 ORDER BY created_at",
        [userId],
      ),
      app.pg.query(
        "SELECT id, user_agent, ip, created_at, last_seen_at FROM user_sessions WHERE user_id = $1 ORDER BY created_at",
        [userId],
      ),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      profile: profile.rows[0] || null,
      messages: messages.rows,
      channelMemberships: memberships.rows,
      reminders: reminders.rows,
      sessions: sessions.rows,
    };
  });

  // ===== 注销账户 =====

  // POST /api/profile/deactivate
  app.post("/deactivate", { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const { password } = (req.body as Record<string, unknown>) || {};
    if (typeof password !== "string" || !password) return reply.status(400).send({ error: "需要密码确认" });
    const r = await app.pg.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
    const u = r.rows[0] as Record<string, unknown> | undefined;
    if (!u || !(await bcrypt.compare(password, u.password_hash as string))) {
      return reply.status(401).send({ error: "密码不正确" });
    }
    await app.pg.query(
      `UPDATE users SET deactivated_at = now(), email = NULL,
              token_version = gen_random_uuid()::text, updated_at = now()
        WHERE id = $1`,
      [userId],
    );
    await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
      userId,
    ]);
    await app.pg.query("UPDATE machine_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
      userId,
    ]);
    const { clearSessionCache } = await import("../lib/session-check.js");
    clearSessionCache();
    clearAuthCookies(reply);
    return { ok: true };
  });

  // ===== 令牌管理 =====

  // GET /api/profile/tokens
  app.get("/tokens", { preHandler: [app.authenticate] }, async (req) => {
    const userId = req.user.sub;
    const result = await app.pg.query(
      "SELECT id, token_prefix, expires_at, revoked_at, created_at FROM machine_tokens WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return { tokens: result.rows };
  });

  // DELETE /api/profile/tokens/:id
  app.delete("/tokens/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as Record<string, string>;
    const userId = req.user.sub;
    const r = await app.pg.query(
      "UPDATE machine_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, userId],
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "token not found" });
    return { ok: true };
  });

  // POST /api/profile/machine-token
  app.post("/machine-token", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.body as Record<string, unknown>;
    const userId = req.user.sub;

    const { getOrCreatePersonalOrg, getUserOrgIds } = await import("../lib/orgs.js");
    let orgId: string;
    if (serverId) {
      const myOrgs = await getUserOrgIds(app, userId);
      if (!myOrgs.includes(String(serverId))) return reply.status(403).send({ error: "not a member of that org" });
      orgId = String(serverId);
    } else {
      orgId = await getOrCreatePersonalOrg(app, userId, req.user.handle);
    }

    const prefix = "sk_machine_";
    // 24 字节 CSPRNG → base64url 32 字符（192 bit 熵）；Math.random 是可预测的
    // V8 PRNG，不能作为凭据随机源（评估报告 P0.1）
    const tokenValue = prefix + randomBytes(24).toString("base64url");
    // 高熵随机令牌用 sha256 落库（见 lib/token-hash.ts）——认证走唯一索引 O(1)，
    // 取代全表扫描 + 逐行 bcrypt 的热路径
    const { sha256Token } = await import("../lib/token-hash.js");
    const hash = sha256Token(tokenValue);

    await app.pg.query(
      "INSERT INTO machine_tokens (user_id, server_id, token_hash, token_prefix, scope) VALUES ($1, $2, $3, $4, $5)",
      [userId, orgId, hash, prefix, JSON.stringify({ send: true, read: true, tasks: true })],
    );
    return { token: tokenValue, prefix, serverId: orgId, message: "Save this token — it won't be shown again" };
  });

  // ===== 原 auth.ts 中的旧路由入口移入结束 =====
}
