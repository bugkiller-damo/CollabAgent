import { FastifyInstance } from "fastify";

export async function messageRoutes(app: FastifyInstance) {
  app.get("/", async (req) => {
    const { channel, before, after, limit } = req.query as Record<string, string>;
    return { ok: true, data: { messages: [], hasMore: false } };
  });

  app.post("/", async (req, reply) => {
    const { target, content } = req.body as { target: string; content: string };
    // TODO: seq 自增、持久化、WS 广播
    return { ok: true, data: { state: "sent", messageId: "mock-id", messageSeq: 1 } };
  });

  app.get("/search", async (req) => {
    const { q } = req.query as { q: string };
    return { ok: true, data: { results: [], total: 0 } };
  });

  app.post("/:messageId/reactions", async (req) => {
    return { ok: true };
  });

  app.delete("/:messageId/reactions", async (req) => {
    return { ok: true };
  });
}
