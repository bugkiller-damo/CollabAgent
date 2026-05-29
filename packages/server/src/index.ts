import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyJwt from "@fastify/jwt";
import pgPlugin from "./db/connection.js";
import { sql } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";

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
import { wsHandler } from "./ws/handler.js";

const server = Fastify({ logger: true });

// Plugins
await server.register(cors, { origin: true, credentials: true });
await server.register(fastifyWebsocket);
await server.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || "dev-secret-change-in-production",
});
await server.register(pgPlugin);

// Auth decorator — supports JWT, dev-token, and machine token
server.decorate("authenticate", async function (request: any, reply: any) {
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

  // JWT
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ error: "Unauthorized" });
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
await server.register(integrationRoutes, { prefix: "/api/integrations" });
await server.register(actionRoutes, { prefix: "/api/actions" });
await server.register(agentRoutes, { prefix: "/internal/agent" });

// WebSocket
server.register(async function (scope) {
  scope.get("/ws", { websocket: true }, wsHandler);
});

// Health check
server.get("/api/health", async () => ({ status: "ok", time: new Date().toISOString() }));

// Public agent list (for management UI)
server.get("/api/agents", async () => {
  const agents = await server.pg.query(
    "SELECT id, name, display_name, description, status, runtime_profile, created_at FROM agents ORDER BY created_at DESC"
  );
  const { daemonClients } = await import("./ws/handler.js");
  return {
    agents: (agents.rows as any[]).map((a) => ({
      ...a,
      isOnline: Array.from(daemonClients.keys()).some((k) => {
        // A daemon is online for agents created by the same user
        return true; // Simplified: all connected daemons can serve any agent
      }),
    })),
  };
});

server.post("/api/agents", { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const { name, displayName, description, runtime, model, serverId } = req.body;
  if (!name || !serverId) return reply.status(400).send({ error: "name and serverId required" });
  const result = await server.pg.query(
    "INSERT INTO agents (user_id, server_id, name, display_name, description, runtime_profile) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *",
    [req.user.sub, serverId, name, displayName || name, description || "", JSON.stringify({ runtime: runtime || "claude", model: model || "sonnet" })]
  );
  return { agent: result.rows[0] };
});

// Server info (for frontend sidebar)
server.get("/api/server/info", async () => {
  const serverResult = await server.pg.query("SELECT id, name FROM servers LIMIT 1");
  const serverId = (serverResult.rows[0] as any)?.id;
  if (!serverId) return { channels: [], agents: [], humans: [] };
  const channels = await server.pg.query(
    "SELECT DISTINCT ON (c.id) c.* FROM channels c WHERE c.server_id = $1 AND c.archived = false",
    [serverId]
  );
  return { serverId, serverName: (serverResult.rows[0] as any)?.name, channels: channels.rows, agents: [], humans: [] };
});

// Auto-migrate on startup
await runMigrations();
console.log("[DB] Schema migrated");

  // Auto-seed default data (first run only)
  const serverCount = await sql`SELECT count(*)::int as c FROM servers`;
  if (serverCount[0].c === 0) {
    const [sv] = await sql`INSERT INTO servers (name, created_by) VALUES ('Default Server', '00000000-0000-0000-0000-000000000000') RETURNING id`;
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
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export type { server as App };
