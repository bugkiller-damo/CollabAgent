import { FastifyInstance } from "fastify";

export async function channelRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return { ok: true, data: { channels: [] } };
  });

  app.post("/", async (req, reply) => {
    return { ok: true, data: { channel: {} } };
  });

  app.get("/:channelId", async (req) => {
    const { channelId } = req.params as { channelId: string };
    return { ok: true, data: { channel: { id: channelId } } };
  });

  app.post("/:channelId/join", async (req) => {
    return { ok: true };
  });

  app.post("/:channelId/leave", async (req) => {
    return { ok: true };
  });

  app.get("/:channelId/members", async () => {
    return { ok: true, data: { members: [] } };
  });
}
