import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getStorage, isAllowedMimeType } from "../lib/storage.js";
import { canAccessChannel } from "../lib/access.js";

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

  app.get("/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const attachmentId = (req.params as Record<string, string>).id;
    const userId = req.user.sub;
    const result = await app.pg.query<{ id: string; storage_key: string; mime_type: string; filename: string; uploader_id: string }>(
      "SELECT * FROM attachments WHERE id = $1",
      [attachmentId]
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: "not found" });
    const row = result.rows[0];

    // 访问控制：上传者本人，或附件所挂消息所在频道的成员。
    // 尚未挂到任何消息的附件（发送前先上传的场景）仅上传者可访问。
    const isUploader = String(row.uploader_id) === String(userId);
    if (!isUploader) {
      const links = await app.pg.query<{ channel_id: string }>(
        `SELECT m.channel_id FROM message_attachments ma
          JOIN messages m ON m.id = ma.message_id
         WHERE ma.attachment_id = $1 LIMIT 5`,
        [attachmentId]
      );
      let allowed = false;
      for (const link of links.rows) {
        if (await canAccessChannel(app, String(link.channel_id), userId)) { allowed = true; break; }
      }
      if (!allowed) return reply.status(403).send({ error: "no access to this attachment" });
    }

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
