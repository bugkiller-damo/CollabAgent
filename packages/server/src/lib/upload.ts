import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { getStorage, isAllowedMimeType, newStorageKey } from "./storage.js";

/**
 * 人类/Agent 共用的 multipart 附件上传收编（F2/F3，方案
 * docs/2026-09-16/01-file-upload-refactor-plan.md 批次一）。
 *
 * 收编前两份独立实现已漂移出实质缺陷：
 * - Agent 侧直接用原始文件名拼 key（未走 sanitizeFilename，F2）；
 * - Agent 侧缺 buf.length > MAX_UPLOAD_SIZE 的 per-file 二次校验（F3）。
 * 单入口后校验口径天然一致，漂移不可能再发生。
 *
 * 校验链（顺序固定，逐 fail-closed）：
 * multipart fileSize 截断/异常 → 413；MIME 白名单 → 415；
 * per-file 大小二次校验（防御纵深：multipart 限制变更/绕过时仍兜底）→ 413。
 * 通过后经 newStorageKey（uuid + sanitizeFilename）落存储、写 attachments 行。
 */

const maxUploadMb = Math.floor(config.MAX_UPLOAD_SIZE / 1024 / 1024);

export interface UploadedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

/**
 * 执行上传全流程；校验失败时发送错误响应并原样返回 reply。
 * 路由直接 `return handleAttachmentUpload(...)` 即可。
 */
export async function handleAttachmentUpload(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  uploader: { id: string; type: "human" | "agent" },
): Promise<UploadedAttachment | FastifyReply> {
  const data = await req.file();
  if (!data) return reply.status(400).send({ error: "file required" });
  let buf: Buffer;
  try {
    buf = await data.toBuffer();
  } catch {
    // 超过 multipart fileSize 限制
    return reply.status(413).send({ error: `file too large (max ${maxUploadMb}MB)` });
  }
  if (data.file?.truncated) {
    return reply.status(413).send({ error: `file too large (max ${maxUploadMb}MB)` });
  }
  if (!isAllowedMimeType(data.mimetype)) {
    return reply.status(415).send({ error: `file type ${data.mimetype} not allowed` });
  }
  // 显式 per-file 大小校验（防御纵深：multipart 限制变更/绕过时仍兜底）
  if (buf.length > config.MAX_UPLOAD_SIZE) {
    return reply.status(413).send({ error: `file too large (max ${maxUploadMb}MB)` });
  }
  const storage = getStorage();
  const filename = data.filename || "file";
  const storageKey = newStorageKey(filename);
  await storage.save(storageKey, buf);
  const url = storage.publicUrl(storageKey);
  const result = await app.pg.query<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    storage_url: string;
  }>(
    "INSERT INTO attachments (uploader_id, uploader_type, filename, mime_type, size_bytes, storage_key, storage_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename, mime_type, size_bytes, storage_key, storage_url",
    [uploader.id, uploader.type, filename, data.mimetype, buf.length, storageKey, url],
  );
  const row = result.rows[0];
  return {
    attachmentId: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    url: row.storage_url,
  };
}
