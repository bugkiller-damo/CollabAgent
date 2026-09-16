import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { getStorage, isAllowedMimeType, newStorageKey } from "./storage.js";
import { makeThumbnail, THUMBABLE_MIME, thumbKeyFor } from "./thumbnail.js";

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
  // F10 SHA256 去重：同内容（跨用户/跨频道）复用首个命中行的 storage_key，字节只存一份。
  // 安全性：调用方必须已持有文件内容才能算出/匹配 hash，不构成内容存在性探测面；
  // 字节删除方（GC/频道删除）按 storage_key 引用计数兜底，共享 key 不会被误删。
  // 并发同内容首传可能双双未命中各存一份——无害（不腐化，仅该次没去重）。
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const dup = await app.pg.query<{ storage_key: string; thumb_key: string | null }>(
    "SELECT storage_key, thumb_key FROM attachments WHERE sha256 = $1 ORDER BY created_at ASC LIMIT 1",
    [sha256],
  );
  let storageKey: string;
  let thumbKey: string | null;
  if (dup.rows.length > 0) {
    // F10/F11：字节与缩略图一并复用（命中行是 F11 前存量时 thumb_key 为 NULL，不补生成）
    storageKey = String(dup.rows[0].storage_key);
    thumbKey = dup.rows[0].thumb_key;
  } else {
    storageKey = newStorageKey(filename);
    await storage.save(storageKey, buf);
    // F11：图片生成 ≤400px webp 缩略图；失败（坏图/sharp 不可用）降级为无缩略图，不阻塞上传
    thumbKey = null;
    if (THUMBABLE_MIME.has(data.mimetype)) {
      const thumb = await makeThumbnail(buf);
      if (thumb) {
        thumbKey = thumbKeyFor(storageKey);
        await storage.save(thumbKey, thumb);
      }
    }
  }
  const url = storage.publicUrl(storageKey);
  const result = await app.pg.query<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    storage_url: string;
  }>(
    "INSERT INTO attachments (uploader_id, uploader_type, filename, mime_type, size_bytes, storage_key, storage_url, sha256, thumb_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, filename, mime_type, size_bytes, storage_key, storage_url",
    [uploader.id, uploader.type, filename, data.mimetype, buf.length, storageKey, url, sha256, thumbKey],
  );
  const row = result.rows[0];
  return {
    attachmentId: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    // F7：对外一律发 ACL 端点 URL；storage_url 列仍写库（local 为 /files/...），
    // 但只作内部句柄（GC/删除定位字节用），不再下发给客户端。
    url: "/api/attachments/" + row.id,
  };
}
