import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../lib/config.js";
import { clearAuthCookies, newCsrfToken, setAuthCookies } from "../lib/cookies.js";
import {
  clearLoginFailures,
  clientIpOf,
  loginLockRemainingMs,
  normalizeAccount,
  recordLoginFailure,
} from "../lib/login-lock.js";
import { validatePassword } from "../lib/validators.js";

const REFRESH_SECRET = config.REFRESH_SECRET;

function signRefresh(payload: object): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: "30d" });
}

function sessionMaxAge(remember?: boolean): number {
  return (remember ? 30 : 7) * 24 * 3600;
}

async function recordSession(app: FastifyInstance, req: any, userId: string): Promise<string> {
  const sid = randomUUID();
  const ua = String(req.headers["user-agent"] || "").slice(0, 500);
  const ip = clientIpOf(req);
  await app.pg.query(
    "INSERT INTO user_sessions (id, user_id, refresh_id, user_agent, ip) VALUES ($1, $2, $1, $3, $4)",
    [sid, userId, ua, ip],
  );
  return sid;
}

// 登录防爆破已迁移 lib/login-lock.ts（O6）：账号 + IP 双维度、共享存储、成功清除。

export async function authRoutes(app: FastifyInstance) {
  // ---- Register ----
  app.post("/register", async (req, reply) => {
    const { email, handle, password, displayName } = req.body as Record<string, unknown>;
    if (!email || !handle || !password) {
      return reply.status(400).send({ error: "邮箱、用户名和密码为必填项" });
    }
    if (typeof handle !== "string" || !/^[a-zA-Z0-9_]{2,20}$/.test(handle)) {
      return reply.status(400).send({ error: "用户名仅支持字母数字下划线，2-20 位" });
    }
    const pwErr = validatePassword(password as string);
    if (pwErr) return reply.status(400).send({ error: pwErr });

    const existing = await app.pg.query("SELECT id FROM users WHERE lower(handle) = $1 OR lower(email) = $2", [
      handle.toLowerCase(),
      (email as string).toLowerCase(),
    ]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({ error: "用户名或邮箱已被注册" });
    }

    const hash = await bcrypt.hash(password as string, 12);
    const result = await app.pg.query(
      "INSERT INTO users (email, handle, display_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, handle, display_name, email",
      [email, handle, displayName || handle, hash],
    );
    const user = result.rows[0] as Record<string, unknown>;

    const inviteToken = (req.body as Record<string, unknown>).invite;
    if (typeof inviteToken === "string" && inviteToken) {
      const inv = await app.pg.query<{
        server_id: string;
        role: string;
        max_uses: number | null;
        uses: number;
        expires_at: string | null;
        revoked_at: string | null;
      }>("SELECT server_id, role, max_uses, uses, expires_at, revoked_at FROM invites WHERE token = $1", [inviteToken]);
      const row = inv.rows[0];
      const valid =
        row &&
        !row.revoked_at &&
        (!row.expires_at || new Date(row.expires_at) >= new Date()) &&
        (row.max_uses == null || row.uses < row.max_uses);
      if (valid) {
        await app.pg.query(
          "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [row.server_id, user.id, row.role],
        );
        await app.pg.query("UPDATE invites SET uses = uses + 1 WHERE token = $1", [inviteToken]);
      }
    }

    const sid = await recordSession(app, req, String(user.id));
    const accessToken = app.jwt.sign(
      { sub: user.id, handle: user.handle, tv: user.token_version, sid },
      { expiresIn: "7d" },
    );
    const refreshToken = signRefresh({ sub: user.id, type: "refresh", sid });
    const csrf = newCsrfToken();
    setAuthCookies(reply, accessToken, csrf, sessionMaxAge(false));

    return {
      token: accessToken,
      refreshToken,
      csrf,
      user: {
        id: user.id,
        handle: user.handle,
        displayName: user.display_name,
        email: user.email,
        description: user.description || "",
        avatarUrl: user.avatar_url || "",
      },
    };
  });

  // ---- Login ----
  app.post("/login", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const login = (body.login || body.handle) as string;
    const password = body.password as string;
    const remember = (body.remember || body.rememberMe) as boolean | undefined;
    if (!login || !password) {
      return reply.status(400).send({ error: "请输入用户名/邮箱和密码" });
    }

    const lockKey = normalizeAccount(login as string);
    const ip = clientIpOf(req);
    // O6：账号 + IP 双维度锁定（任一命中即 429），状态在共享存储（多实例一致）
    const lockedMs = await loginLockRemainingMs(lockKey, ip);
    if (lockedMs > 0) {
      const mins = Math.max(1, Math.ceil(lockedMs / 60000));
      return reply.status(429).send({ error: `登录失败次数过多，请 ${mins} 分钟后再试` });
    }

    const result = await app.pg.query(
      "SELECT id, handle, display_name, email, description, avatar_url, password_hash, token_version, deactivated_at FROM users WHERE lower(handle) = $1 OR lower(email) = $1",
      [(login as string).toLowerCase()],
    );

    if (result.rows.length === 0) {
      await recordLoginFailure(lockKey, ip);
      return reply.status(401).send({ error: "用户不存在" });
    }

    const user = result.rows[0] as Record<string, unknown>;
    if (user.deactivated_at) {
      return reply.status(403).send({ error: "该账户已注销" });
    }
    if (!(await bcrypt.compare(password as string, user.password_hash as string))) {
      await recordLoginFailure(lockKey, ip);
      return reply.status(401).send({ error: "密码错误" });
    }

    await clearLoginFailures(lockKey, ip);

    const sid = await recordSession(app, req, String(user.id));
    const expiresIn = remember ? "30d" : "7d";
    const accessToken = app.jwt.sign({ sub: user.id, handle: user.handle, tv: user.token_version, sid }, { expiresIn });
    const refreshToken = signRefresh({ sub: user.id, type: "refresh", sid });
    const csrf = newCsrfToken();
    setAuthCookies(reply, accessToken, csrf, sessionMaxAge(!!remember));
    const { inc } = await import("../lib/metrics.js");
    inc("logins");

    return {
      token: accessToken,
      refreshToken,
      csrf,
      user: { id: user.id, handle: user.handle, displayName: user.display_name, email: user.email },
    };
  });

  // ---- Refresh（轮换：吊销旧会话 → 创新会话 → 发新 refresh + 新 CSRF）----
  app.post("/refresh", async (req, reply) => {
    const body = (req.body as Record<string, unknown>) || {};
    const { parseCookies, ACCESS_COOKIE } = await import("../lib/cookies.js");
    const refreshToken = body.refreshToken as string | undefined;
    if (!refreshToken) {
      const cookieTok = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
      if (!cookieTok) return reply.status(400).send({ error: "refreshToken required" });
    }
    try {
      const decoded = jwt.verify(refreshToken as string, REFRESH_SECRET) as Record<string, unknown>;
      if (decoded.type !== "refresh") throw new Error("not a refresh token");
      if (decoded.sid) {
        const s = await app.pg.query(
          "SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
          [decoded.sid, decoded.sub],
        );
        if (s.rows.length === 0) return reply.status(401).send({ error: "session revoked" });
        // 轮换：吊销旧会话，创建新会话
        await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [decoded.sid]);
      }
      const user = await app.pg.query("SELECT id, handle, token_version FROM users WHERE id = $1", [decoded.sub]);
      if (user.rows.length === 0) return reply.status(401).send({ error: "user not found" });
      const u = user.rows[0] as Record<string, unknown>;
      // 新会话
      const newSid = await recordSession(app, req, String(u.id));
      const accessToken = app.jwt.sign(
        { sub: u.id, handle: u.handle, tv: u.token_version, sid: newSid },
        { expiresIn: "7d" },
      );
      const newRefresh = signRefresh({ sub: u.id, type: "refresh", sid: newSid });
      const csrf = newCsrfToken();
      setAuthCookies(reply, accessToken, csrf, sessionMaxAge(true));
      return { token: accessToken, refreshToken: newRefresh, csrf };
    } catch {
      return reply.status(401).send({ error: "refresh token invalid or expired" });
    }
  });

  // ---- Logout (current device) ----
  app.post("/logout", { preHandler: [app.authenticate] }, async (req, reply) => {
    const sid = req.user?.sid;
    if (sid) await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [sid]);
    const { clearSessionCache } = await import("../lib/session-check.js");
    clearSessionCache();
    clearAuthCookies(reply);
    return { ok: true };
  });

  // ---- Logout all devices ----
  app.post("/logout-all", { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
      userId,
    ]);
    await app.pg.query("UPDATE users SET token_version = gen_random_uuid()::text WHERE id = $1", [userId]);
    const { clearSessionCache } = await import("../lib/session-check.js");
    clearSessionCache();
    clearAuthCookies(reply);
    return { ok: true };
  });

  // ---- Session list ----
  app.get("/sessions", { preHandler: [app.authenticate] }, async (req) => {
    const userId = req.user.sub;
    const curSid = req.user?.sid || null;
    const r = await app.pg.query(
      `SELECT id, user_agent, ip, created_at, last_seen_at
         FROM user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC`,
      [userId],
    );
    return { sessions: r.rows.map((s) => ({ ...s, current: s.id === curSid })) };
  });

  // ---- Revoke session ----
  app.delete("/sessions/:sid", { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const { sid } = req.params as Record<string, string>;
    const r = await app.pg.query(
      "UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [sid, userId],
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "session not found" });
    const { clearSessionCache } = await import("../lib/session-check.js");
    clearSessionCache();
    return { ok: true };
  });
}
