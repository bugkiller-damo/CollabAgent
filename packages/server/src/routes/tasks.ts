import { FastifyInstance } from "fastify";

export async function taskRoutes(app: FastifyInstance) {
  app.get("/", async (req) => {
    const { channel, status } = req.query as Record<string, string>;
    return { ok: true, data: { tasks: [] } };
  });

  app.post("/", async (req) => {
    const { channel, tasks } = req.body as { channel: string; tasks: { title: string }[] };
    return { ok: true, data: { tasks: [] } };
  });

  app.post("/claim", async (req) => {
    return { ok: true, data: { results: [] } };
  });

  app.post("/unclaim", async (req) => {
    return { ok: true };
  });

  app.patch("/:taskNumber/status", async (req) => {
    return { ok: true, data: { task: {} } };
  });
}
