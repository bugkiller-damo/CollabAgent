import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { clearAuthCookies, newCsrfToken, setAuthCookies } from "../lib/cookies.js";
import {
  clearLoginFailures,
  clientIpOf,
  loginLockRemainingMs,
  normalizeAccount,
  recordLoginFailure,
} from "../lib/login-lock.js";
import { generateResetCode, hashResetCode, RESET_CODE_TTL_MS, resetCodeMatches } from "../lib/password-reset.js";
import { validatePassword } from "../lib/validators.js";

// P1.16：假 bcrypt 哈希（内容无关，仅耗时特征有效——12 轮 bcrypt.compare 恒失败）。
// 「用户不存在」路径与之比对，使该路径与「密码错误」路径执行同量级的 KDF 耗时，
// 抹平响应时序差，防账号存在性探测（配合统一 401 文案）。
const TIMING_BALANCE_BCRYPT_HASH = "$2a$12$dPMf9jDeKEnTNtkoIRO3Be8CnqGzM/CSoKAgfw6heCExMN/Td4aqW";

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
    // P1.15：签发走 @fastify/jwt 双 namespace（access/refresh，注册见 index.ts），
    // 取代 jsonwebtoken 直签的双库并存。
    const accessToken = app.jwt.access.sign(
      { sub: user.id, handle: user.handle, tv: user.token_version, sid },
      { expiresIn: "7d" },
    );
    const refreshToken = app.jwt.refresh.sign({ sub: user.id, type: "refresh", sid });
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
      // P1.16：用户不存在与密码错误走完全相同的失败形态——先做一次假 bcrypt
      // 比对平衡 KDF 时序（否则「不存在」跳过 12 轮 bcrypt 的时序差可探测账号
      // 存在性），再统一 401 通用文案，不再区分「用户不存在/密码错误」。
      await bcrypt.compare(password as string, TIMING_BALANCE_BCRYPT_HASH);
      await recordLoginFailure(lockKey, ip);
      return reply.status(401).send({ error: "用户名或密码错误" });
    }

    const user = result.rows[0] as Record<string, unknown>;
    if (!(await bcrypt.compare(password as string, user.password_hash as string))) {
      await recordLoginFailure(lockKey, ip);
      return reply.status(401).send({ error: "用户名或密码错误" });
    }
    // P1.16：注销账号的 403 挪到密码校验之后——原先在校验前返回，任意密码
    // 都能探测「账号存在且已注销」；现在必须持有正确密码才能得知注销状态。
    if (user.deactivated_at) {
      return reply.status(403).send({ error: "该账户已注销" });
    }

    await clearLoginFailures(lockKey, ip);

    const sid = await recordSession(app, req, String(user.id));
    const expiresIn = remember ? "30d" : "7d";
    const accessToken = app.jwt.access.sign(
      { sub: user.id, handle: user.handle, tv: user.token_version, sid },
      { expiresIn },
    );
    const refreshToken = app.jwt.refresh.sign({ sub: user.id, type: "refresh", sid });
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

  // ---- Forgot / Reset password（P1.20：补齐 web ForgotPasswordPage.vue 契约）----
  // web 契约：forgot → {message, devCode?}；reset → {email, code, password}。
  // 仓库无邮件基建：完整验证码流仅在 SLOCK_DEV_RESET_CODE=1 显式开启（devCode 回传
  // 响应，仅限本地开发/演示；collectInsecureConfig 标记，生产无 ALLOW_INSECURE 启动即
  // 拒——同 P1.17 SLOCK_DEV_TOKEN 模式）。开关关闭时恒返回诚实文案、不落任何状态；
  // 两路径已在 index.ts CSRF 豁免名单（登录前无会话，regex 覆盖 forgot|reset 前缀）。
  const RESET_DISABLED_MSG = "密码重置未开放，请联系工作区管理员重置密码";
  // 通用失败文案：无此邮箱/无有效码/已过期/码不符/已被并发消费 统一形态，不区分原因
  const RESET_INVALID_MSG = "重置码无效或已过期";
  const RESET_GENERIC_MSG = "如果该邮箱已注册，重置验证码已生成，请按页面提示使用";
  const devResetEnabled = () => process.env.SLOCK_DEV_RESET_CODE === "1";

  app.post("/forgot-password", async (req) => {
    if (!devResetEnabled()) return { message: RESET_DISABLED_MSG };
    const { email } = (req.body as Record<string, unknown>) || {};
    const e = typeof email === "string" ? email.trim().toLowerCase() : "";
    // 非法/未注册邮箱同形态返回（不泄露存在性；dev 开关下 devCode 有无仍可探测
    // 存在性——该开关本身即不安全模式，已由 collectInsecureConfig 立此存照）
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { message: RESET_GENERIC_MSG };
    const u = await app.pg.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [e]);
    if (u.rows.length === 0) return { message: RESET_GENERIC_MSG };
    const code = generateResetCode();
    // 新码签发即覆盖旧码（单列自然失效），TTL 10 分钟
    await app.pg.query("UPDATE users SET reset_code = $2, reset_expires = $3 WHERE id = $1", [
      u.rows[0].id,
      hashResetCode(code),
      new Date(Date.now() + RESET_CODE_TTL_MS),
    ]);
    return { message: RESET_GENERIC_MSG, devCode: code };
  });

  app.post("/reset-password", async (req, reply) => {
    if (!devResetEnabled()) return reply.status(403).send({ error: RESET_DISABLED_MSG });
    const { email, code, password } = (req.body as Record<string, unknown>) || {};
    if (typeof email !== "string" || typeof code !== "string" || typeof password !== "string" || !email || !code) {
      return reply.status(400).send({ error: RESET_INVALID_MSG });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return reply.status(400).send({ error: pwErr });
    const u = await app.pg.query<{ id: string; reset_code: string | null; reset_expires: Date | null }>(
      "SELECT id, reset_code, reset_expires FROM users WHERE lower(email) = $1",
      [email.trim().toLowerCase()],
    );
    const row = u.rows[0];
    // 验证码校验（sha256 时序安全比对 + JS 侧快速 TTL 预检）；无码/过期/不符同文案
    if (!row || !row.reset_code || !row.reset_expires || new Date(row.reset_expires) <= new Date()) {
      return reply.status(400).send({ error: RESET_INVALID_MSG });
    }
    if (!resetCodeMatches(code, row.reset_code)) {
      return reply.status(400).send({ error: RESET_INVALID_MSG });
    }
    // 消费 + TTL 复核 + 改密 + token_version 轮换一条条件 UPDATE 原子完成：
    // 并发双 reset 只有一个成功（单次使用）；被消费（reset_code 已置 NULL）后 0 行
    const hash = await bcrypt.hash(password, 12);
    const done = await app.pg.query<{ id: string }>(
      `UPDATE users
         SET password_hash = $2, reset_code = NULL, reset_expires = NULL,
             token_version = gen_random_uuid()::text, updated_at = now()
       WHERE id = $1 AND reset_code = $3 AND reset_expires > now()
       RETURNING id`,
      [row.id, hash, row.reset_code],
    );
    if (done.rows.length === 0) return reply.status(400).send({ error: RESET_INVALID_MSG });
    // 密码已变 → 吊销全部会话（对齐 logout-all / change-password 语义：旧设备全下线）
    await app.pg.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
      row.id,
    ]);
    const { clearSessionCache } = await import("../lib/session-check.js");
    clearSessionCache();
    return { ok: true };
  });

  // ---- Refresh（轮换：吊销旧会话 → 创新会话 → 发新 refresh + 新 CSRF）----
  app.post("/refresh", async (req, reply) => {
    const body = (req.body as Record<string, unknown>) || {};
    // P1.16：删除「cookie 回退」死码分支——原逻辑在没有 body.refreshToken 时读
    // access cookie 顶替，随后仍按 REFRESH_SECRET 验签（永远验不过，恒 401），
    // 只会误导维护者。refresh 令牌仅接受 body 显式传入（web 侧即如此调用）。
    const refreshToken = body.refreshToken as string | undefined;
    if (!refreshToken) {
      return reply.status(400).send({ error: "refreshToken required" });
    }
    try {
      // P1.15：refresh 令牌验证走 @fastify/jwt refresh namespace（独立 REFRESH_SECRET）
      const decoded = app.jwt.refresh.verify(refreshToken as string) as Record<string, unknown>;
      if (decoded.type !== "refresh") throw new Error("not a refresh token");
      // P1.16：sid 强制必须存在——本服务签发的 refresh token 都带 sid；无 sid 的
      // （伪造/极早期）令牌不再跳过吊销校验，直接按无效处理，封掉「无 sid 的
      // refresh 绕过会话吊销检查」的理论缺口。
      if (!decoded.sid) throw new Error("missing sid");
      {
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
      const accessToken = app.jwt.access.sign(
        { sub: u.id, handle: u.handle, tv: u.token_version, sid: newSid },
        { expiresIn: "7d" },
      );
      const newRefresh = app.jwt.refresh.sign({ sub: u.id, type: "refresh", sid: newSid });
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
