import type { FastifyInstance, FastifyReply } from "fastify";
import { canAccessChannel } from "../lib/access.js";
import { getStorage } from "../lib/storage.js";
import { handleAttachmentUpload } from "../lib/upload.js";

interface AttachmentRow {
  id: string;
  storage_key: string;
  mime_type: string;
  filename: string;
  uploader_id: string;
}

/**
 * 附件读取的统一出口：鉴权（上传者或所挂消息频道成员）→ ?meta 返回元数据行 → 否则出文件字节。
 * GET /:id 与 GET /by-key 共用，保证两条路径的访问控制完全一致。
 */
async function serveAttachment(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
  row: AttachmentRow,
  meta: boolean,
): Promise<unknown> {
  // 访问控制：上传者本人，或附件所挂消息所在频道的成员。
  // 尚未挂到任何消息的附件（发送前先上传的场景）仅上传者可访问。
  const isUploader = String(row.uploader_id) === String(userId);
  if (!isUploader) {
    const links = await app.pg.query<{ channel_id: string }>(
      `SELECT m.channel_id FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
       WHERE ma.attachment_id = $1 LIMIT 5`,
      [row.id],
    );
    let allowed = false;
    for (const link of links.rows) {
      if (await canAccessChannel(app, String(link.channel_id), userId)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return reply.status(403).send({ error: "no access to this attachment" });
  }

  // ?meta=1 返回元数据；默认直接下载文件字节（供 slock attachment view 使用）
  if (meta) return row;
  try {
    const buf = await getStorage().read(row.storage_key);
    reply.header("Content-Type", row.mime_type || "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(row.filename)}"`);
    return reply.send(buf);
  } catch {
    return reply.status(404).send({ error: "file bytes not found" });
  }
}

export async function attachmentRoutes(app: FastifyInstance) {
  // F2/F3：上传全流程收编到 lib/upload.ts（人类/Agent 同一校验链，漂移不可能再发生）
  app.post("/upload", { preHandler: [app.authenticate] }, async (req, reply) => {
    return handleAttachmentUpload(app, req, reply, { id: req.user.sub, type: "human" });
  });

  // 注意：/by-key 必须注册在 /:id 之前，否则 "by-key" 会被当作 :id。
  // S3 私有桶（未配置 S3_PUBLIC_BASE_URL）的 publicUrl 指向这里：服务端鉴权 + 访问控制后代理字节。
  app.get("/by-key", { preHandler: [app.authenticate] }, async (req, reply) => {
    const query = req.query as Record<string, string>;
    if (!query.key) return reply.status(400).send({ error: "key required" });
    const result = await app.pg.query<AttachmentRow>("SELECT * FROM attachments WHERE storage_key = $1 LIMIT 1", [
      query.key,
    ]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "not found" });
    return serveAttachment(app, reply, req.user.sub, result.rows[0], Boolean(query.meta));
  });

  app.get("/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const attachmentId = (req.params as Record<string, string>).id;
    const userId = req.user.sub;
    const result = await app.pg.query<AttachmentRow>("SELECT * FROM attachments WHERE id = $1", [attachmentId]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "not found" });
    return serveAttachment(app, reply, userId, result.rows[0], Boolean((req.query as Record<string, string>).meta));
  });
}
