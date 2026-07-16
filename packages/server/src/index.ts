import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyJwt from "@fastify/jwt";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import pgPlugin, { closeDb } from "./db/connection.js";
import { sql } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { UPLOAD_DIR } from "./lib/storage.js";
import { config, validateConfig } from "./lib/config.js";
import { rateLimitHook } from "./lib/rate-limit.js";

validateConfig();

import { authRoutes } from "./routes/auth.js";
import { channelRoutes } from "./routes/channels.js";
import { messageRoutes } from "./routes/messages.js";
import { taskRoutes } from "./routes/tasks.js";
import { reminderRoutes } from "./routes/reminders.js";
import { profileRoutes } from "./routes/profile.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { integrationRoutes } from "./routes/integrations.js";
import { actionRoutes } from "./routes/actions.js";
import { notificationRoutes } from "./routes/notifications.js";
import { agentRoutes } from "./routes/agents.js";
import { agentMessageRoutes } from "./routes/agents-messages.js";
import { agentTaskRoutes } from "./routes/agents-tasks.js";
import { agentReminderRoutes } from "./routes/agents-reminders.js";
import { previewRoutes } from "./routes/preview.js";
import { orgRoutes } from "./routes/orgs.js";
import { metricsRoutes } from "./routes/metrics.js";
import { wsHandler } from "./ws/handler.js";
import { agentPublicRoutes } from "./routes/agents-public.js";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

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
await server.register(fastifyStatic, { root: UPLOAD_DIR, prefix: "/files/", decorateReply: false });

// Auth decorator — supports JWT (Bearer 或 httpOnly cookie), dev-token, and machine token
server.decorate("authenticate", async function (request: any, reply: any) {
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

  // Machine token (sk_machine_*)
  if (token.startsWith("sk_machine_")) {
    const bcrypt = (await import("bcryptjs")).default;
    const result = await server.pg.query<{ user_id: string; server_id: string; scope: string; token_hash: string }>(
      "SELECT user_id, server_id, scope, token_hash FROM machine_tokens WHERE token_prefix = 'sk_machine_' AND revoked_at IS NULL"
    );
    for (const row of result.rows) {
      if (await bcrypt.compare(token, row.token_hash)) {
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
    try { request.user = server.jwt.verify(cookieTok); return; }
    catch { return reply.status(401).send({ error: "Unauthorized" }); }
  }

  return reply.status(401).send({ error: "Unauthorized" });
});

// 全局限流（onRequest 早于 CSRF 校验，先拦截异常流量）
server.addHook("onRequest", rateLimitHook);

// CSRF（double-submit）：仅对「cookie 鉴权 + 改写型方法」生效；Bearer/机器令牌与登录引导路径豁免。
server.addHook("onRequest", async (request: any, reply: any) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const authHeader = request.headers.authorization || "";
  if (authHeader.startsWith("Bearer ") || authHeader.startsWith("sk_machine_")) return; // 非 cookie 鉴权，无 CSRF 风险
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
await server.register(notificationRoutes);
await server.register(orgRoutes, { prefix: "/api" });
await server.register(agentPublicRoutes, { prefix: "/api" });
await server.register(metricsRoutes, { prefix: "/api" });

// WebSocket
server.register(async function (scope) {
  scope.get("/ws", { websocket: true }, wsHandler);
});

// Health check（含 DB 连通性）
server.get("/api/health", async () => {
  let dbOk = false;
  try {
    await server.pg.query("SELECT 1");
    dbOk = true;
  } catch { /* DB degraded */ }
  return { status: dbOk ? "ok" : "degraded", db: dbOk, time: new Date().toISOString() };
});

// 当前用户的 daemon 是否已连上（接入向导第 1 步轮询用）
server.get("/api/daemon/status", { preHandler: [server.authenticate] }, async (req: any) => {
  const { daemonClients } = await import("./ws/handler.js");
  return { connected: daemonClients.has(String(req.user.sub)) };
});

// Public user list (for @mention autocomplete)
server.get("/api/users", async () => {
  const users = await server.pg.query(
    "SELECT id, handle, display_name, avatar_url FROM users ORDER BY handle"
  );
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
  for (const [, ws] of daemonClients) { try { ws.close(1001, "server shutdown"); } catch { /* ignore */ } }
  for (const [, sockets] of browserClients) {
    for (const ws of sockets) { try { ws.close(1001, "server shutdown"); } catch { /* ignore */ } }
  }
  await closeDb();
  server.log.info("[Server] Goodbye");
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export type { server as App };
