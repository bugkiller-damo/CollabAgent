import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyJwt from "@fastify/jwt";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import pgPlugin from "./db/connection.js";
import { sql } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { UPLOAD_DIR } from "./lib/storage.js";

import { authRoutes } from "./routes/auth.js";
import { channelRoutes } from "./routes/channels.js";
import { messageRoutes } from "./routes/messages.js";
import { taskRoutes } from "./routes/tasks.js";
import { reminderRoutes } from "./routes/reminders.js";
import { profileRoutes } from "./routes/profile.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { integrationRoutes } from "./routes/integrations.js";
import { actionRoutes } from "./routes/actions.js";
import { agentRoutes } from "./routes/agents.js";
import { previewRoutes } from "./routes/preview.js";
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
await server.register(cors, { origin: true, credentials: true });
await server.register(fastifyWebsocket);
await server.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || "dev-secret-change-in-production",
});
await server.register(pgPlugin);
// 注入 pg 给 WS 层，用于按频道成员定向投递（关闭私有频道泄露面）
{
  const { setWsPg } = await import("./ws/handler.js");
  setWsPg((server as any).pg);
}
await server.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });
await server.register(fastifyStatic, { root: UPLOAD_DIR, prefix: "/files/", decorateReply: false });

// Auth decorator — supports JWT (Bearer 或 httpOnly cookie), dev-token, and machine token
server.decorate("authenticate", async function (request: any, reply: any) {
  const { parseCookies, ACCESS_COOKIE } = await import("./lib/cookies.js");
  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (authHeader === "Bearer dev-token") {
    request.user = { sub: "dev-user", handle: "dev" };
    return;
  }

  // Machine token (sk_machine_*)
  if (token.startsWith("sk_machine_")) {
    const bcrypt = (await import("bcryptjs")).default;
    const result = await server.pg.query(
      "SELECT user_id, server_id, scope, token_hash FROM machine_tokens WHERE token_prefix = 'sk_machine_' AND revoked_at IS NULL"
    );
    for (const row of result.rows as any[]) {
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

  // JWT via Bearer
  if (token) {
    try { request.user = server.jwt.verify(token); return; }
    catch { return reply.status(401).send({ error: "Unauthorized" }); }
  }

  // JWT via httpOnly cookie（浏览器走这条）
  const cookieTok = parseCookies(request.headers.cookie)[ACCESS_COOKIE];
  if (cookieTok) {
    try { request.user = server.jwt.verify(cookieTok); return; }
    catch { return reply.status(401).send({ error: "Unauthorized" }); }
  }

  return reply.status(401).send({ error: "Unauthorized" });
});

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

// WebSocket
server.register(async function (scope) {
  scope.get("/ws", { websocket: true }, wsHandler);
});

// Health check
server.get("/api/health", async () => ({ status: "ok", time: new Date().toISOString() }));

// 运维指标：进程计数器 + 实时网关（在线 daemon / agent 数）
server.get("/api/metrics", async () => {
  const { metricsSnapshot } = await import("./lib/metrics.js");
  const { daemonClients } = await import("./ws/handler.js");
  let agentCount = 0;
  try { agentCount = Number((await server.pg.query("SELECT count(*)::int as c FROM agents")).rows[0]?.c || 0); } catch { /* ignore */ }
  return metricsSnapshot({ online: { daemons: daemonClients.size, agents: agentCount } });
});

// Public user list (for @mention autocomplete)
server.get("/api/users", async () => {
  const users = await server.pg.query(
    "SELECT id, handle, display_name, avatar_url FROM users ORDER BY handle"
  );
  return { users: users.rows };
});

// Agent 列表（按调用者所属组织过滤可见性）
server.get("/api/agents", { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const { getUserOrgIds } = await import("./lib/orgs.js");
  const orgIds = await getUserOrgIds(server as any, req.user.sub);
  if (orgIds.length === 0) return { agents: [] };
  const agents = await server.pg.query(
    "SELECT id, name, display_name, description, status, runtime_profile, server_id, created_at FROM agents WHERE server_id::text = ANY($1) ORDER BY created_at DESC",
    [orgIds]
  );
  const { daemonClients } = await import("./ws/handler.js");
  const anyDaemon = daemonClients.size > 0;
  return {
    agents: (agents.rows as any[]).map((a) => {
      const rp = parseRuntimeProfile(a.runtime_profile);
      return { ...a, runtime_profile: rp, runtime: rp.runtime || "claude", model: rp.model || "sonnet", isOnline: anyDaemon };
    }),
  };
});

// runtime_profile 可能是正确的 jsonb 对象，也可能是历史遗留的「双重编码字符串」，统一解析
function parseRuntimeProfile(v: any): { runtime?: string; model?: string } {
  if (!v) return {};
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return {}; } }
  return v;
}

server.post("/api/agents", { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const { name, displayName, description, runtime, model, serverId } = req.body;
  if (!name) return reply.status(400).send({ error: "name required" });
  const { getOrCreatePersonalOrg, getUserOrgIds } = await import("./lib/orgs.js");
  // serverId 省略 → 落到创建者的个人组织（仅本人可见，可后续把别人加进来共享）；
  // 若指定 serverId，必须是创建者所属的组织。
  let orgId: string;
  if (serverId) {
    const myOrgs = await getUserOrgIds(server as any, req.user.sub);
    if (!myOrgs.includes(String(serverId))) return reply.status(403).send({ error: "not a member of that org" });
    orgId = String(serverId);
  } else {
    orgId = await getOrCreatePersonalOrg(server as any, req.user.sub, req.user.handle);
  }
  const result = await server.pg.query(
    "INSERT INTO agents (user_id, server_id, name, display_name, description, runtime_profile) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *",
    [req.user.sub, orgId, name, displayName || name, description || "", sql.json({ runtime: runtime || "claude", model: model || "sonnet" })]
  );
  const agent = result.rows[0] as any;
  // Auto-start: notify all connected daemons to spawn this agent
  const { broadcastToDaemons } = await import("./ws/handler.js");
  broadcastToDaemons({
    type: "agent:start",
    agent: { id: agent.id, name: agent.name, displayName: agent.display_name, runtime: runtime || "claude", model: model || "sonnet" },
    config: { runtime_profile: agent.runtime_profile },
  });
  return { agent };
});

// Edit agent（资料 + 运行时）
server.patch("/api/agents/:agentId", { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const { agentId } = req.params;
  const { name, displayName, description, runtime, model } = req.body || {};
  const sets: string[] = [];
  const params: any[] = [];
  let p = 1;
  if (name !== undefined) { sets.push(`name = $${p++}`); params.push(name); }
  if (displayName !== undefined) { sets.push(`display_name = $${p++}`); params.push(displayName); }
  if (description !== undefined) { sets.push(`description = $${p++}`); params.push(description); }
  if (runtime !== undefined || model !== undefined) {
    sets.push(`runtime_profile = $${p++}::jsonb`);
    params.push(sql.json({ runtime: runtime || "claude", model: model || "sonnet" }));
  }
  if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
  params.push(agentId);
  const r = await server.pg.query(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
    params
  );
  if (r.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
  const agent = r.rows[0] as any;
  const rp = parseRuntimeProfile(agent.runtime_profile);
  const { broadcastToDaemons } = await import("./ws/handler.js");
  broadcastToDaemons({
    type: "agent:start",
    agentId: agent.id,
    config: { name: agent.name, displayName: agent.display_name, description: agent.description, runtime: rp.runtime, model: rp.model },
  });
  return { agent: { ...agent, runtime_profile: rp, runtime: rp.runtime, model: rp.model } };
});

// Delete agent（连带频道成员关系；保留历史消息）
server.delete("/api/agents/:agentId", { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const { agentId } = req.params;
  const exists = await server.pg.query("SELECT id FROM agents WHERE id = $1", [agentId]);
  if (exists.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
  await server.pg.query("DELETE FROM channel_members WHERE member_id = $1 AND member_type = 'agent'", [agentId]);
  await server.pg.query("DELETE FROM agents WHERE id = $1", [agentId]);
  const { broadcastToDaemons } = await import("./ws/handler.js");
  broadcastToDaemons({ type: "agent:stop", agentId });
  return { ok: true };
});

// --- 组织（协作组）成员管理 ---

// 我所属的组织列表
server.get("/api/orgs", { preHandler: [(server as any).authenticate] }, async (req: any) => {
  // 确保用户至少有一个个人组织（懒创建），这样协作面板始终可用
  const { getOrCreatePersonalOrg } = await import("./lib/orgs.js");
  try { await getOrCreatePersonalOrg(server as any, req.user.sub, req.user.handle); } catch { /* ignore */ }
  const r = await server.pg.query(
    `SELECT s.id, s.name, s.personal, s.owner_id, sm.role,
            (SELECT count(*)::int FROM server_members WHERE server_id = s.id) as "memberCount",
            (SELECT count(*)::int FROM agents WHERE server_id = s.id) as "agentCount"
       FROM server_members sm JOIN servers s ON s.id = sm.server_id
      WHERE sm.user_id::text = $1
      ORDER BY s.personal DESC, s.created_at ASC`,
    [req.user.sub]
  );
  return { orgs: r.rows };
});

async function isOrgOwner(serverId: string, userId: string): Promise<boolean> {
  const r = await server.pg.query(
    "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2 AND role = 'owner'", [serverId, userId]
  );
  if (r.rows.length > 0) return true;
  const s = await server.pg.query("SELECT 1 FROM servers WHERE id = $1 AND owner_id::text = $2", [serverId, userId]);
  return s.rows.length > 0;
}

// 组织成员列表（需为成员）
server.get("/api/orgs/:serverId/members", { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const { serverId } = req.params;
  const me = await server.pg.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2", [serverId, req.user.sub]);
  if (me.rows.length === 0) return reply.status(403).send({ error: "not a member" });
  const r = await server.pg.query(
    `SELECT sm.user_id, sm.role, u.handle, u.display_name
       FROM server_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = $1 ORDER BY sm.role DESC, u.handle`,
    [serverId]
  );
  return { members: r.rows };
});

// 邀请成员（仅 owner）
server.post("/api/orgs/:serverId/members", { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const { serverId } = req.params;
  const { handle } = req.body || {};
  if (!handle) return reply.status(400).send({ error: "handle required" });
  if (!(await isOrgOwner(serverId, req.user.sub))) return reply.status(403).send({ error: "only org owner can invite" });
  const u = await server.pg.query("SELECT id FROM users WHERE handle = $1", [String(handle).replace(/^@/, "")]);
  if (u.rows.length === 0) return reply.status(404).send({ error: "user not found" });
  await server.pg.query(
    "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
    [serverId, (u.rows[0] as any).id]
  );
  return { ok: true };
});

// 移除成员（仅 owner；不能移除 owner 自己）
server.delete("/api/orgs/:serverId/members/:userId", { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const { serverId, userId } = req.params;
  if (!(await isOrgOwner(serverId, req.user.sub))) return reply.status(403).send({ error: "only org owner can remove" });
  await server.pg.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2 AND role <> 'owner'", [serverId, userId]);
  return { ok: true };
});

// Server info (for frontend sidebar)
server.get("/api/server/info", { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const { getDefaultServerId } = await import("./lib/server.js");
  const serverId = await getDefaultServerId(server as any);
  if (!serverId) return { channels: [], agents: [], humans: [] };
  const serverResult = await server.pg.query("SELECT id, name FROM servers WHERE id = $1", [serverId]);
  const userId = req.user?.sub;
  // 公开频道对所有登录用户可见；私有频道仅成员可见
  const channels = await server.pg.query(
    `SELECT DISTINCT ON (c.id) c.*, cm.role
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id::text = $2 AND cm.member_type = 'human'
      WHERE c.server_id = $1 AND c.archived = false AND c.type <> 'dm'
        AND (c.type <> 'private' OR cm.role IS NOT NULL)`,
    [serverId, userId]
  );
  const humans = await server.pg.query(
    "SELECT id, handle, display_name, avatar_url FROM users ORDER BY handle"
  );
  return { serverId, serverName: (serverResult.rows[0] as any)?.name, channels: channels.rows, agents: [], humans: humans.rows };
});

// Auto-migrate on startup
await runMigrations();
console.log("[DB] Schema migrated");

  // Auto-seed default data (first run only)
  const serverCount = await sql`SELECT count(*)::int as c FROM servers`;
  if (serverCount[0].c === 0) {
    // created_by 留空：播种时通常还没有用户（首个注册用户会被并入此服务器）
    const [sv] = await sql`INSERT INTO servers (name, created_by) VALUES ('Default Server', NULL) RETURNING id`;
    for (const ch of ["general", "random", "engineering"]) {
      await sql`INSERT INTO channels (server_id, name, description) VALUES (${sv.id}, ${ch}, ${ch === "general" ? "General discussion" : ch === "random" ? "Random topics" : "Engineering team"})`;
    }
    console.log("[DB] Seed data created: 1 server, 3 channels");
  }

// Start
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || "0.0.0.0";

try {
  await server.listen({ port, host });
  console.log(`CollabAgent server running at http://${host}:${port}`);
  const { startReminderScheduler } = await import("./lib/reminder-scheduler.js");
  startReminderScheduler(server as any);
  console.log("[Reminder] scheduler started");
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export type { server as App };
