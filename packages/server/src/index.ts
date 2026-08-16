import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import pgPlugin, { closeDb, sql } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { config, validateConfig } from "./lib/config.js";
import { rateLimitHook } from "./lib/rate-limit.js";
import { UPLOAD_DIR } from "./lib/storage.js";

validateConfig();

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { actionRoutes } from "./routes/actions.js";
import { agentRoutes } from "./routes/agents.js";
import { agentCredentialRoutes } from "./routes/agents-credentials.js";
import { agentDispatchRoutes } from "./routes/agents-dispatch.js";
import { agentMessageRoutes } from "./routes/agents-messages.js";
import { agentPublicRoutes } from "./routes/agents-public.js";
import { agentReminderRoutes } from "./routes/agents-reminders.js";
import { agentTaskRoutes } from "./routes/agents-tasks.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { authRoutes } from "./routes/auth.js";
import { channelRoutes } from "./routes/channels.js";
import { integrationRoutes } from "./routes/integrations.js";
import { messageRoutes } from "./routes/messages.js";
import { metricsRoutes } from "./routes/metrics.js";
import { notificationRoutes } from "./routes/notifications.js";
import { orgRoutes } from "./routes/orgs.js";
import { previewRoutes } from "./routes/preview.js";
import { profileRoutes } from "./routes/profile.js";
import { reminderRoutes } from "./routes/reminders.js";
import { taskRoutes } from "./routes/tasks.js";
import { wsHandler } from "./ws/handler.js";

const server = Fastify({
  logger: true,
  // 请求关联：尊重入站 x-request-id，否则自动生成，日志里随每条请求记录
  requestIdHeader: "x-request-id",
  requestIdLogLabel: "reqId",
});

// 统一错误处理：结构化记录 + 计数 + 不泄露堆栈
server.setErrorHandler(async (err: any, request: any, reply: any) => {
  const { inc } = await import("./lib/metrics.js");
  inc("errors");
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  request.log.error({ err, reqId: request.id, url: request.url, method: request.method }, "request_error");
  reply.status(status).send({ error: status >= 500 ? "Internal Server Error" : err.message || "Error" });
});

// Plugins
const CORS_ORIGINS = process.env.CORS_ORIGINS?.split(",") || [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3001",
];
await server.register(cors, { origin: CORS_ORIGINS, credentials: true });

// OpenAPI / Swagger
await server.register(swagger, {
  openapi: {
    info: { title: "CollabAgent API", version: "0.1.0", description: "Collaborative Agent Platform API" },
    servers: [{ url: `http://localhost:${config.PORT}` }],
  },
});
await server.register(swaggerUi, { routePrefix: "/docs" });

await server.register(fastifyWebsocket);
await server.register(fastifyJwt, {
  secret: config.JWT_SECRET,
});
await server.register(pgPlugin);
// 注入 pg 给 WS 层，用于按频道成员定向投递（关闭私有频道泄露面）
{
  const { setWsPg } = await import("./ws/handler.js");
  setWsPg(server.pg);
}
await server.register(fastifyMultipart, { limits: { fileSize: config.MAX_UPLOAD_SIZE } });

// Auth decorator — supports JWT (Bearer 或 httpOnly cookie), dev-token, and machine token
server.decorate("authenticate", async (request: any, reply: any) => {
  const { parseCookies, ACCESS_COOKIE } = await import("./lib/cookies.js");
  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (authHeader === "Bearer dev-token") {
    if (process.env.NODE_ENV === "production") {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    request.user = { sub: "dev-user", handle: "dev" };
    return;
  }

  // Agent-run scoped token (sk_agent_*) —— 每次 daemon spawn 一个 agent PTY 时签发，
  // 只在这个 agentId 范围内有效，不像 sk_machine_ 那样是账号级全权限。
  // 只有带 :agentId 路径参数的路由才能用这种 token 认证——鉴权时直接按这个
  // agentId 做单条索引查找（比 sk_machine_ 的全表扫描+逐行 bcrypt 更高效），
  // 因为 Fastify 的 preHandler 在路由匹配完成之后才跑，此时 request.params 已就绪。
  if (token.startsWith("sk_agent_")) {
    const agentId = (request.params as Record<string, string> | undefined)?.agentId;
    if (!agentId) return reply.status(401).send({ error: "Invalid agent token" });
    const { verifyTokenHash } = await import("./lib/token-hash.js");
    const cred = await server.pg.query<{ token_hash: string; user_id: string; name: string }>(
      `SELECT ac.token_hash, a.user_id, a.name
       FROM agent_credentials ac JOIN agents a ON a.id = ac.agent_id
       WHERE ac.agent_id = $1 AND ac.revoked_at IS NULL AND (ac.expires_at IS NULL OR ac.expires_at > now())`,
      [agentId],
    );
    if (cred.rows.length > 0 && (await verifyTokenHash(token, cred.rows[0].token_hash))) {
      request.user = { sub: cred.rows[0].user_id, handle: cred.rows[0].name, scope: "agent-run", agentId };
      return;
    }
    return reply.status(401).send({ error: "Invalid or expired agent token" });
  }

  // Machine token (sk_machine_*)
  if (token.startsWith("sk_machine_")) {
    const { sha256Token, isBcryptHash } = await import("./lib/token-hash.js");
    // 快路径：sha256 哈希直接按唯一索引命中（新签发的令牌都走这里）
    const fast = await server.pg.query<{ user_id: string; scope: string }>(
      "SELECT user_id, scope FROM machine_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
      [sha256Token(token)],
    );
    if (fast.rows.length > 0) {
      const user = await server.pg.query("SELECT id, handle FROM users WHERE id = $1", [fast.rows[0].user_id]);
      if (user.rows.length > 0) {
        request.user = { sub: user.rows[0].id, handle: user.rows[0].handle, scope: fast.rows[0].scope };
        return;
      }
      return reply.status(401).send({ error: "Invalid machine token" });
    }
    // 兼容路径：历史 bcrypt 哈希的令牌（等全部轮换/吊销后可删除此分支）
    const bcrypt = (await import("bcryptjs")).default;
    const legacy = await server.pg.query<{ user_id: string; scope: string; token_hash: string }>(
      "SELECT user_id, scope, token_hash FROM machine_tokens WHERE revoked_at IS NULL",
    );
    for (const row of legacy.rows) {
      if (isBcryptHash(row.token_hash) && (await bcrypt.compare(token, row.token_hash))) {
        const user = await server.pg.query("SELECT id, handle FROM users WHERE id = $1", [row.user_id]);
        if (user.rows.length > 0) {
          request.user = { sub: user.rows[0].id, handle: user.rows[0].handle, scope: row.scope };
          return;
        }
      }
    }
    return reply.status(401).send({ error: "Invalid machine token" });
  }

  // 纯 httpOnly Cookie 鉴权（Bearer JWT 路径已废弃 —— 强制从 cookie 取 JWT，避免 XSS 窃 token）
  const cookieTok = parseCookies(request.headers.cookie)[ACCESS_COOKIE];
  if (cookieTok) {
    try {
      const payload = server.jwt.verify(cookieTok) as { sub: string; sid?: string; tv?: string };
      // 会话状态回查：logout-all / 改密 / 注销会吊销 session 或滚动 token_version，
      // 不查的话旧 access token 在 7 天有效期内仍能用（lib/session-check.ts，5s 缓存）。
      if (payload?.sid) {
        const { isSessionValid } = await import("./lib/session-check.js");
        if (!(await isSessionValid(server, String(payload.sid), String(payload.sub), payload.tv))) {
          return reply.status(401).send({ error: "Session expired or revoked" });
        }
      }
      request.user = payload;
      return;
    } catch {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  }

  return reply.status(401).send({ error: "Unauthorized" });
});

// /files/ 静态附件下载同样需要鉴权：浏览器 <img>/<a> 同源自动带 cookie，
// daemon 走 sk_* Bearer —— 两者都能过 authenticate；未登录匿名访问直接 401。
// 注意：这里只能挡「未登录」，频道成员级别的细粒度校验在 /api/attachments/:id 里做。
// 必须在 authenticate 装饰器注册之后再挂 hook，否则 hook 拿到的是 undefined。
await server.register(async (filesScope) => {
  filesScope.addHook("onRequest", server.authenticate as any);
  await filesScope.register(fastifyStatic, { root: UPLOAD_DIR, prefix: "/files/", decorateReply: false });
});

// 全局限流（onRequest 早于 CSRF 校验，先拦截异常流量）
server.addHook("onRequest", rateLimitHook);

// CSRF（double-submit）：仅对「cookie 鉴权 + 改写型方法」生效；Bearer/机器令牌与登录引导路径豁免。
server.addHook("onRequest", async (request: any, reply: any) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const authHeader = request.headers.authorization || "";
  // Bearer 令牌（含 sk_machine_/sk_agent_）鉴权无 cookie 会话，无 CSRF 风险。
  // 注意判断的是 Bearer 头整体，而不是直接匹配 sk_ 前缀（令牌永远以 "Bearer sk_..." 形式出现）。
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (bearerToken) return;
  const { parseCookies, ACCESS_COOKIE, CSRF_COOKIE } = await import("./lib/cookies.js");
  const cookies = parseCookies(request.headers.cookie);
  if (!cookies[ACCESS_COOKIE]) return; // 未用 cookie 会话（如登录前）
  const url = (request.url || "").split("?")[0];
  // 登录引导/无会话路径豁免
  if (/^\/api\/auth\/(login|register|refresh|forgot|reset)/.test(url)) return;
  const headerTok = request.headers["x-csrf-token"];
  if (!headerTok || headerTok !== cookies[CSRF_COOKIE]) {
    return reply.status(403).send({ error: "CSRF token invalid or missing" });
  }
});

// Routes
await server.register(authRoutes, { prefix: "/api/auth" });
await server.register(channelRoutes, { prefix: "/api/channels" });
await server.register(messageRoutes, { prefix: "/api/messages" });
await server.register(taskRoutes, { prefix: "/api/tasks" });
await server.register(reminderRoutes, { prefix: "/api/reminders" });
await server.register(profileRoutes, { prefix: "/api/profile" });
await server.register(attachmentRoutes, { prefix: "/api/attachments" });
await server.register(previewRoutes, { prefix: "/api/preview" });
await server.register(integrationRoutes, { prefix: "/api/integrations" });
await server.register(actionRoutes, { prefix: "/api/actions" });
await server.register(agentRoutes, { prefix: "/internal/agent" });
await server.register(agentMessageRoutes, { prefix: "/internal/agent" });
await server.register(agentTaskRoutes, { prefix: "/internal/agent" });
await server.register(agentReminderRoutes, { prefix: "/internal/agent" });
await server.register(agentCredentialRoutes, { prefix: "/internal/agent" });
await server.register(agentDispatchRoutes, { prefix: "/internal/agent" });
await server.register(notificationRoutes);
await server.register(orgRoutes, { prefix: "/api" });
await server.register(agentPublicRoutes, { prefix: "/api" });
await server.register(metricsRoutes, { prefix: "/api" });

// WebSocket
server.register(async (scope) => {
  scope.get("/ws", { websocket: true }, wsHandler);
});

// Health check（含 DB 连通性）
server.get("/api/health", async () => {
  let dbOk = false;
  try {
    await server.pg.query("SELECT 1");
    dbOk = true;
  } catch {
    /* DB degraded */
  }
  return { status: dbOk ? "ok" : "degraded", db: dbOk, time: new Date().toISOString() };
});

// 当前用户的 daemon 是否已连上（接入向导第 1 步轮询用）
server.get("/api/daemon/status", { preHandler: [server.authenticate] }, async (req: any) => {
  const { daemonClients } = await import("./ws/handler.js");
  return { connected: daemonClients.has(String(req.user.sub)) };
});

// Public user list (for @mention autocomplete) — 需登录，避免未认证枚举全站用户
server.get("/api/users", { preHandler: [server.authenticate] }, async () => {
  const users = await server.pg.query("SELECT id, handle, display_name, avatar_url FROM users ORDER BY handle");
  return { users: users.rows };
});

// Auto-migrate on startup
await runMigrations();
server.log.info("[DB] Schema migrated");

// Auto-seed default data (first run only)
const serverCount = await sql`SELECT count(*)::int as c FROM servers`;
if (serverCount[0].c === 0) {
  // created_by 留空：播种时通常还没有用户（首个注册用户会被并入此服务器）
  const [sv] = await sql`INSERT INTO servers (name, created_by) VALUES ('Default Server', NULL) RETURNING id`;
  for (const ch of ["general", "random", "engineering"]) {
    await sql`INSERT INTO channels (server_id, name, description) VALUES (${sv.id}, ${ch}, ${ch === "general" ? "General discussion" : ch === "random" ? "Random topics" : "Engineering team"})`;
  }
  server.log.info("[DB] Seed data created: 1 server, 3 channels");
}

// Start
const port = config.PORT;
const host = config.HOST;

try {
  await server.listen({ port, host });
  server.log.info(`CollabAgent server running at http://${host}:${port}`);
  const { startReminderScheduler } = await import("./lib/reminder-scheduler.js");
  startReminderScheduler(server);
  server.log.info("[Reminder] scheduler started");
  const { startMetricsPersistence } = await import("./lib/metrics-persist.js");
  startMetricsPersistence(server);
  const { restoreCounters } = await import("./lib/metrics.js");
  await restoreCounters(server.pg);
  server.log.info("[Metrics] persistence started (60s interval)");
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

// 优雅关闭
async function shutdown(signal: string) {
  server.log.info(`[Server] Received ${signal}, shutting down gracefully...`);
  const { daemonClients, browserClients } = await import("./ws/handler.js");
  for (const [, ws] of daemonClients) {
    try {
      ws.close(1001, "server shutdown");
    } catch {
      /* ignore */
    }
  }
  for (const [, sockets] of browserClients) {
    for (const ws of sockets) {
      try {
        ws.close(1001, "server shutdown");
      } catch {
        /* ignore */
      }
    }
  }
  await closeDb();
  server.log.info("[Server] Goodbye");
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export type { server as App };
