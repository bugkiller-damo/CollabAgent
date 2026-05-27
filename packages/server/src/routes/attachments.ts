import type { FastifyInstance } from "fastify";

export async function attachmentRoutes(app: FastifyInstance) {
  app.post("/upload", { preHandler: [app.authenticate] }, async (req, reply) => {
    const data = await (req as any).file();
    if (!data) return reply.status(400).send({ error: "file required" });
    const buf = await data.toBuffer();
    const storageKey = "attachments/" + crypto.randomUUID() + "/" + (data.filename || "file");
    const result = await app.pg.query(
      "INSERT INTO attachments (uploader_id, uploader_type, filename, mime_type, size_bytes, storage_key, storage_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [(req as any).user.sub, "human", data.filename, data.mimetype, buf.length, storageKey, "/files/" + storageKey]
    );
    return { attachmentId: result.rows[0].id };
  });

  app.get("/:id", async (req, reply) => {
    const result = await app.pg.query("SELECT * FROM attachments WHERE id = $1", [(req.params as any).id]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "not found" });
    return result.rows[0];
  });
}
