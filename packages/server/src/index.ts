import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyJwt from "@fastify/jwt";

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

// Auth decorator
server.decorate("authenticate", async function (request: any, reply: any) {
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
