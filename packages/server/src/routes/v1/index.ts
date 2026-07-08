import type { FastifyInstance } from "fastify";
import { assetRoutes } from "./assets.js";
import { taskRoutes } from "./tasks.js";
import { caseRoutes } from "./cases.js";
import { alertRoutes } from "./alerts.js";

export async function v1Routes(app: FastifyInstance) {
  await app.register(assetRoutes, { prefix: "/assets" });
  await app.register(taskRoutes, { prefix: "/tasks" });
  await app.register(caseRoutes, { prefix: "/cases" });
  await app.register(alertRoutes, { prefix: "/alerts" });
}
