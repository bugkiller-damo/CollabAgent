import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getStorage, isAllowedMimeType } from "../lib/storage.js";

export async function attachmentRoutes(app: FastifyInstance) {
  app.post("/upload", { preHandler: [app.authenticate] }, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: "file required" });
    let buf: Buffer;
    try {
      buf = await data.toBuffer();
    } catch {
      // 超过 multipart fileSize 限制
      return reply.status(413).send({ error: "file too large (max 10MB)" });
    }
    if (data.file?.truncated) {
      return reply.status(413).send({ error: "file too large (max 10MB)" });
    }
    if (!isAllowedMimeType(data.mimetype)) {
      return reply.status(415).send({ error: `file type ${data.mimetype} not allowed` });
    }
    const storage = getStorage();
    const filename = data.filename || "file";
    const storageKey = randomUUID() + "/" + filename;
    await storage.save(storageKey, buf);
    const url = storage.publicUrl(storageKey);
    const result = await app.pg.query(
      "INSERT INTO attachments (uploader_id, uploader_type, filename, mime_type, size_bytes, storage_key, storage_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename, mime_type, size_bytes, storage_url",
      [req.user.sub, "human", filename, data.mimetype, buf.length, storageKey, url]
    );
    const row = result.rows[0];
    return {
      attachmentId: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      url: row.storage_url,
    };
  });

  app.get("/:id", async (req, reply) => {
    const result = await app.pg.query<{ storage_key: string; mime_type: string; filename: string }>("SELECT * FROM attachments WHERE id = $1", [(req.params as Record<string, string>).id]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "not found" });
    const row = result.rows[0];
    // ?meta=1 返回元数据；默认直接下载文件字节（供 slock attachment view 使用）
    if ((req.query as Record<string, string>).meta) return row;
    try {
      const buf = await getStorage().read(row.storage_key);
      reply.header("Content-Type", row.mime_type || "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(row.filename)}"`);
      return reply.send(buf);
    } catch {
      return reply.status(404).send({ error: "file bytes not found" });
    }
  });
}
