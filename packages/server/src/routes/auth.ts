import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "dev-refresh-secret";

function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(pw)) return "密码需包含字母";
  if (!/[0-9]/.test(pw)) return "密码需包含数字";
  return null;
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
    const accessToken = app.jwt.sign({ sub: user.id, handle: user.handle, tv: 0 }, { expiresIn: "1h" });
    const refreshToken = app.jwt.sign({ sub: user.id, type: "refresh" }, { expiresIn: "30d" }, REFRESH_SECRET);

    return { token: accessToken, refreshToken, user: { id: user.id, handle: user.handle, displayName: user.display_name, email: user.email } };
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

    const result = await app.pg.query(
      "SELECT id, handle, display_name, email, password_hash, token_version FROM users WHERE lower(handle) = $1 OR lower(email) = $1",
      [(login as string).toLowerCase()]
    );

    if (result.rows.length === 0) {
      return reply.status(401).send({ code: "AUTH_FAILED", error: "用户不存在" });
    }

    const user = result.rows[0] as Record<string, unknown>;
    if (!(await bcrypt.compare(password as string, user.password_hash as string))) {
      return reply.status(401).send({ code: "AUTH_FAILED", error: "密码错误" });
    }

    const expiresIn = remember ? "30d" : "7d";
    const accessToken = app.jwt.sign({ sub: user.id, handle: user.handle, tv: user.token_version }, { expiresIn });
    const refreshToken = app.jwt.sign({ sub: user.id, type: "refresh" }, { expiresIn: "30d" }, REFRESH_SECRET);

    return { token: accessToken, refreshToken, user: { id: user.id, handle: user.handle, displayName: user.display_name, email: user.email } };
  });

  // Refresh token
  app.post("/refresh", async (req, reply) => {
    const { refreshToken } = req.body as Record<string, unknown>;
    if (!refreshToken) return reply.status(400).send({ error: "refreshToken required" });
    try {
      const decoded = app.jwt.verify(refreshToken as string, REFRESH_SECRET) as Record<string, unknown>;
      if (decoded.type !== "refresh") throw new Error("not a refresh token");
      const user = await app.pg.query("SELECT id, handle, token_version FROM users WHERE id = $1", [decoded.sub]);
      if (user.rows.length === 0) return reply.status(401).send({ error: "user not found" });
      const u = user.rows[0] as Record<string, unknown>;
      const accessToken = app.jwt.sign({ sub: u.id, handle: u.handle, tv: u.token_version }, { expiresIn: "1h" });
      return { token: accessToken };
    } catch {
      return reply.status(401).send({ error: "refresh token invalid or expired" });
    }
  });

  // Logout all devices (increment token version)
  app.post("/logout-all", { preHandler: [app.authenticate] }, async (req) => {
    const userId = (req as any).user.sub;
    await app.pg.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [userId]);
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
}
