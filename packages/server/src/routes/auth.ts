import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { setAuthCookies, clearAuthCookies, newCsrfToken } from "../lib/cookies.js";

const REFRESH_SECRET = process.env.REFRESH_SECRET || "dev-refresh-secret";

function signRefresh(payload: object): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: "30d" });
}

// access cookie 寿命（秒）。remember 走 30 天，否则 7 天。
function sessionMaxAge(remember?: boolean): number {
  return (remember ? 30 : 7) * 24 * 3600;
}

// 记一条登录会话，返回 sid（也作为 refresh_id）
async function recordSession(app: FastifyInstance, req: any, userId: string): Promise<string> {
  const sid = randomUUID();
  const ua = String(req.headers["user-agent"] || "").slice(0, 500);
  const ip = String((req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "").slice(0, 64);
  await app.pg.query(
    "INSERT INTO user_sessions (id, user_id, refresh_id, user_agent, ip) VALUES ($1, $2, $1, $3, $4)",
    [sid, userId, ua, ip]
  );
  return sid;
}

function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(pw)) return "密码需包含字母";
  if (!/[0-9]/.test(pw)) return "密码需包含数字";
  return null;
}

// 登录限流：连续失败 5 次锁定 15 分钟（内存计数，单实例足够；多实例可换 Redis）
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function checkLoginLock(key: string): number {
  const rec = loginAttempts.get(key);
  if (rec && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
  }
  return 0;
}

function recordLoginFail(key: string): void {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockedUntil = now + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginAttempts.set(key, rec);
}

export async function authRoutes(app: FastifyInstance) {
  // Register
  app.post("/register", async (req, reply) => {
    const { email, handle, password, displayName } = req.body as Record<string, unknown>;
    if (!email || !handle || !password) {
      return reply.status(400).send({ code: "INVALID_ARG", error: "邮箱、用户名和密码为必填项" });
    }
    if (typeof handle !== "string" || !/^[a-zA-Z0-9_]{2,20}$/.test(handle)) {
      return reply.status(400).send({ code: "INVALID_ARG", error: "用户名仅支持字母数字下划线，2-20 位" });
    }
    const pwErr = validatePassword(password as string);
    if (pwErr) return reply.status(400).send({ code: "INVALID_ARG", error: pwErr });

    const existing = await app.pg.query(
      "SELECT id FROM users WHERE lower(handle) = $1 OR lower(email) = $2",
      [handle.toLowerCase(), (email as string).toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send({ code: "CONFLICT", error: "用户名或邮箱已被注册" });
    }

    const hash = await bcrypt.hash(password as string, 12);
    const result = await app.pg.query(
      "INSERT INTO users (email, handle, display_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, handle, display_name, email",
      [email, handle, displayName || handle, hash]
    );
    const user = result.rows[0] as Record<string, unknown>;
    const sid = await recordSession(app, req, String(user.id));
    const accessToken = app.jwt.sign({ sub: user.id, handle: user.handle, tv: user.token_version, sid }, { expiresIn: "7d" });
    const refreshToken = signRefresh({ sub: user.id, type: "refresh", sid });
    const csrf = newCsrfToken();
    setAuthCookies(reply, accessToken, csrf, sessionMaxAge(false));

    return { token: accessToken, refreshToken, csrf, user: { id: user.id, handle: user.handle, displayName: user.display_name, email: user.email, description: user.description || '', avatarUrl: user.avatar_url || '' } };
  });

  // Login (handle OR email)
  app.post("/login", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const login = (body.login || body.handle) as string;
    const password = body.password as string;
    const remember = (body.remember || body.rememberMe) as boolean | undefined;
    if (!login || !password) {
      return reply.status(400).send({ code: "INVALID_ARG", error: "请输入用户名/邮箱和密码" });
    }

    const lockKey = (login as string).toLowerCase();
    const lockedMins = checkLoginLock(lockKey);
    if (lockedMins > 0) {
      return reply.status(429).send({ code: "RATE_LIMITED", error: `登录失败次数过多，请 ${lockedMins} 分钟后再试` });
    }

    const result = await app.pg.query(
      "SELECT id, handle, display_name, email, description, avatar_url, password_hash, token_version, deactivated_at FROM users WHERE lower(handle) = $1 OR lower(email) = $1",
      [(login as string).toLowerCase()]
    );

    if (result.rows.length === 0) {
      recordLoginFail(lockKey);
      return reply.status(401).send({ code: "AUTH_FAILED", error: "用户不存在" });
    }

    const user = result.rows[0] as Record<string, unknown>;
    if (user.deactivated_at) {
      return reply.status(403).send({ code: "ACCOUNT_DEACTIVATED", error: "该账户已注销" });
    }
    if (!(await bcrypt.compare(password as string, user.password_hash as string))) {
      recordLoginFail(lockKey);
      return reply.status(401).send({ code: "AUTH_FAILED", error: "密码错误" });
    }

    loginAttempts.delete(lockKey);

    const sid = await recordSession(app, req, String(user.id));
    const expiresIn = remember ? "30d" : "7d";
    const accessToken = app.jwt.sign({ sub: user.id, handle: user.handle, tv: user.token_version, sid }, { expiresIn });
    const refreshToken = signRefresh({ sub: user.id, type: "refresh", sid });
    const csrf = newCsrfToken();
    setAuthCookies(reply, accessToken, csrf, sessionMaxAge(!!remember));
    const { inc } = await import("../lib/metrics.js");
    inc("logins");

    return { token: accessToken, refreshToken, csrf, user: { id: user.id, handle: user.handle, displayName: user.display_name, email: user.email } };
  });

  // Refresh token（校验会话未被吊销；刷新 access cookie）
  app.post("/refresh", async (req, reply) => {
    const body = (req.body as Record<string, unknown>) || {};
    const { parseCookies, ACCESS_COOKIE } = await import("../lib/cookies.js");
    // refreshToken 可来自 body（旧前端）；cookie 模式下 access 由 cookie 续期
    const refreshToken = body.refreshToken as string | undefined;
    if (!refreshToken) {
      // 没带 refresh：若 access cookie 还在且有效，直接续 csrf（轻量）
      const cookieTok = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
      if (!cookieTok) return reply.status(400).send({ error: "refreshToken required" });
    }
    try {
      const decoded = jwt.verify(refreshToken as string, REFRESH_SECRET) as Record<string, unknown>;
      if (decoded.type !== "refresh") throw new Error("not a refresh token");
      // 会话校验：sid 必须存在且未吊销
      if (decoded.sid) {
        const s = await app.pg.query(
          "SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
          [decoded.sid, decoded.sub]
        );
        if (s.rows.length === 0) return reply.status(401).send({ error: "session revoked" });
        await app.pg.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [decoded.sid]);
      }
      const user = await app.pg.query("SELECT id, handle, token_version FROM users WHERE id = $1", [decoded.sub]);
      if (user.rows.length === 0) return reply.status(401).send({ error: "user not found" });
      const u = user.rows[0] as Record<string, unknown>;
      const accessToken = app.jwt.sign({ sub: u.id, handle: u.handle, tv: u.token_version, sid: decoded.sid }, { expiresIn: "7d" });
      const csrf = newCsrfToken();
      setAuthCookies(reply, accessToken, csrf, sessionMaxAge(true));
      return { token: accessToken, csrf };
    } catch {
      return reply.status(401).send({ error: "refresh token invalid or expired" });
    }
  });

  // 退出当前设备：吊销当前会话 + 清 cookie
  app.post("/logout", { preHandler: [app.authenticate] }, async (req, reply) => {
    const sid = (req as any).user?.sid;
    if (sid) await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [sid]);
    clearAuthCookies(reply);
    return { ok: true };
  });

  // Logout all devices：吊销全部会话 + 轮换 token_version + 清 cookie
  app.post("/logout-all", { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = (req as any).user.sub;
    await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await app.pg.query("UPDATE users SET token_version = gen_random_uuid()::text WHERE id = $1", [userId]);
    clearAuthCookies(reply);
    return { ok: true };
  });

  // 登录设备/会话列表
  app.get("/sessions", { preHandler: [app.authenticate] }, async (req) => {
    const userId = (req as any).user.sub;
    const curSid = (req as any).user?.sid || null;
    const r = await app.pg.query(
      `SELECT id, user_agent, ip, created_at, last_seen_at
         FROM user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC`,
      [userId]
    );
    return { sessions: (r.rows as any[]).map((s) => ({ ...s, current: s.id === curSid })) };
  });

  // 吊销指定会话（远程下线某设备）
  app.delete("/sessions/:sid", { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = (req as any).user.sub;
    const { sid } = req.params as Record<string, string>;
    const r = await app.pg.query(
      "UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [sid, userId]
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "session not found" });
    return { ok: true };
  });

  // Update profile
  // Change password
  app.post("/profile/password", { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = (req as any).user.sub;
    const { oldPassword, newPassword } = req.body as Record<string, unknown>;
    if (typeof oldPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 6) {
      return reply.status(400).send({ error: "新密码至少 6 位" });
    }
    const r = await app.pg.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
    const u = r.rows[0] as Record<string, unknown> | undefined;
    if (!u || !(await bcrypt.compare(oldPassword, u.password_hash as string))) {
      return reply.status(401).send({ error: "当前密码不正确" });
    }
    const h = await bcrypt.hash(newPassword, 12);
    await app.pg.query("UPDATE users SET password_hash = $1 WHERE id = $2", [h, userId]);
    return { ok: true };
  });

  app.patch("/profile", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { displayName, description, avatarUrl } = req.body as Record<string, unknown>;
    const userId = (req as any).user.sub;
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (displayName) { sets.push("display_name = $" + p++); params.push(displayName); }
    if (description !== undefined) { sets.push("description = $" + p++); params.push(description); }
    if (avatarUrl) { sets.push("avatar_url = $" + p++); params.push(avatarUrl); }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields to update" });
    params.push(userId);
    const result = await app.pg.query(
      "UPDATE users SET " + sets.join(", ") + ", updated_at = now() WHERE id = $" + p + " RETURNING id, handle, display_name, description, avatar_url, email",
      params
    );
    const u = result.rows[0] as Record<string, unknown>;
    return { user: { id: u.id, handle: u.handle, displayName: u.display_name, description: u.description, avatarUrl: u.avatar_url, email: u.email } };
  });

  // Change password
  app.post("/change-password", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { oldPassword, newPassword } = req.body as Record<string, unknown>;
    if (!oldPassword || !newPassword) return reply.status(400).send({ error: "请输入旧密码和新密码" });
    const pwErr = validatePassword(newPassword as string);
    if (pwErr) return reply.status(400).send({ error: pwErr });

    const user = await app.pg.query("SELECT password_hash FROM users WHERE id = $1", [(req as any).user.sub]);
    if (!(await bcrypt.compare(oldPassword as string, (user.rows[0] as any).password_hash))) {
      return reply.status(401).send({ error: "旧密码不正确" });
    }
    const hash = await bcrypt.hash(newPassword as string, 12);
    await app.pg.query("UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2", [hash, (req as any).user.sub]);
    return { ok: true };
  });

  // Get current user profile
  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const result = await app.pg.query(
      "SELECT id, handle, display_name, description, avatar_url, email FROM users WHERE id = $1",
      [(req as any).user.sub]
    );
    return { user: result.rows[0] };
  });

  // 导出本人数据（资料 / 消息 / 频道成员 / 提醒 / 会话）
  app.get("/export", { preHandler: [app.authenticate] }, async (req) => {
    const userId = (req as any).user.sub;
    const [profile, messages, memberships, reminders, sessions] = await Promise.all([
      app.pg.query("SELECT id, handle, display_name, email, description, avatar_url, created_at FROM users WHERE id = $1", [userId]),
      app.pg.query("SELECT id, channel_id, content, created_at FROM messages WHERE sender_id = $1 ORDER BY created_at", [userId]),
      app.pg.query("SELECT cm.channel_id, c.name as channel_name, cm.role, cm.joined_at FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE cm.member_id = $1 AND cm.member_type = 'human'", [userId]),
      app.pg.query("SELECT id, title, fire_at, repeat_rule, status, created_at FROM reminders WHERE owner_id = $1 ORDER BY created_at", [userId]),
      app.pg.query("SELECT id, user_agent, ip, created_at, last_seen_at FROM user_sessions WHERE user_id = $1 ORDER BY created_at", [userId]),
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

  // 注销账户（软删）：需密码确认。清空 PII、吊销全部会话与令牌、轮换 token_version、清 cookie。
  // 保留历史消息（其它人协作记录依赖），但账户不可再登录。
  app.post("/deactivate", { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = (req as any).user.sub;
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
      [userId]
    );
    await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await app.pg.query("UPDATE machine_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    clearAuthCookies(reply);
    return { ok: true };
  });

  // Generate machine token for daemon authentication
  app.post("/machine-token", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.body as Record<string, unknown>;
    const userId = (req as any).user.sub;
    if (!serverId) return reply.status(400).send({ error: "serverId required" });

    const prefix = "sk_machine_";
    const randomPart = Array.from({ length: 32 }, () =>
      "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]
    ).join("");
    const tokenValue = prefix + randomPart;
    const hash = await bcrypt.hash(tokenValue, 8);

    await app.pg.query(
      "INSERT INTO machine_tokens (user_id, server_id, token_hash, token_prefix, scope) VALUES ($1, $2, $3, $4, $5)",
      [userId, serverId as string, hash, prefix, JSON.stringify({ send: true, read: true, tasks: true })]
    );
    return { token: tokenValue, prefix, message: "Save this token — it won't be shown again" };
  });
}
