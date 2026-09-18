import type { FastifyInstance, FastifyReply } from "fastify";
import { canAccessChannel } from "../lib/access.js";
import { getStorage, type StorageRange } from "../lib/storage.js";
import { handleAttachmentUpload } from "../lib/upload.js";

interface AttachmentRow {
  id: string;
  storage_key: string;
  mime_type: string;
  filename: string;
  uploader_id: string;
  size_bytes: number;
  thumb_key: string | null;
}

/**
 * F7/F14：可用 inline 方式直出的 MIME 白名单（预览矩阵）。
 * 原则：只放行浏览器按「非可执行内容」渲染的类型——SVG/HTML 恒排除
 * （顶层导航打开 inline SVG/HTML 会在本域执行脚本，XSS）。
 * - 图片：<img> 直显（F7）
 * - 音视频：<video>/<audio>（F9 Range 已就绪，进度条拖动可用；F14）
 * - PDF：iframe/新标签页走浏览器内建阅读器，脚本不落页面上下文（F14）
 * - 纯文本/JSON：浏览器按文本渲染；web 代码块预览走 fetch 读字节不经此路径，
 *   inline 主要服务「新标签页打开」（F14）
 * 本表与上传白名单（ALLOWED_MIME_TYPES）正交。
 */
const INLINE_SAFE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "application/pdf",
  "text/plain",
  "application/json",
]);

/**
 * F9：解析 HTTP Range 头（单区间；多区间/不合法视为无 Range 走全量）。
 * 支持 bytes=start-end / bytes=start- / bytes=-suffixLen。
 * 返回越界标记由调用方结合 totalSize 判 416。
 */
function parseRangeHeader(header: string | undefined, totalSize: number): StorageRange | "invalid" | null {
  if (!header) return null;
  const m = /^\s*bytes=(\d*)-(\d*)\s*$/.exec(header);
  if (!m) return null; // 非 bytes 单位或多区间：忽略，全量回 200
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    // 后缀区间 bytes=-N：最后 N 字节
    const suffix = Number(b);
    if (suffix <= 0) return "invalid";
    start = Math.max(totalSize - suffix, 0);
    end = totalSize - 1;
  } else {
    start = Number(a);
    end = b === "" ? totalSize - 1 : Math.min(Number(b), totalSize - 1);
    if (start > end) return "invalid";
  }
  return { start, end };
}

/**
 * 附件读取的统一出口：鉴权（上传者或所挂消息频道成员）→ ?meta 返回元数据行 → 否则出文件字节。
 * GET /:id 与 GET /by-key 共用，保证两条路径的访问控制完全一致。
 * F7/F14：?inline=1 且 MIME 在 INLINE_SAFE_MIME 时回 inline（web <img>/<video>/<audio>/
 * PDF iframe 直显用）；默认 attachment 下载。
 * F9：字节走流式（不再整文件读内存）；支持 Range（206/416），恒发 Accept-Ranges: bytes。
 * F11：?thumb=1 且有 thumb_key 时出缩略图（webp，恒 inline；无缩略图时回落原图字节）。
 */
async function serveAttachment(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
  row: AttachmentRow,
  meta: boolean,
  inline?: boolean,
  rangeHeader?: string,
  thumb?: boolean,
): Promise<unknown> {
  // 访问控制：上传者本人，或附件所挂消息所在频道的成员。
  // 尚未挂到任何消息的附件（发送前先上传的场景）仅上传者可访问。
  const isUploader = String(row.uploader_id) === String(userId);
  if (!isUploader) {
    const links = await app.pg.query<{ channel_id: string }>(
      `SELECT m.channel_id FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
       WHERE ma.attachment_id = $1
       ORDER BY m.created_at ASC`,
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

  // ?meta=1 返回元数据；默认直接下载文件字节（供 slock attachment view 使用）。
  // 2026-09-17 审计 F5 修复：改白名单字段——此前 SELECT * 整行返回，泄漏
  // storage_url（配置 S3_PUBLIC_BASE_URL 时为无 ACL 永久直链）/ storage_key /
  // thumb_key 内部句柄，绕过后续的成员移除与删除。
  if (meta) {
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      uploaderId: row.uploader_id,
      hasThumb: Boolean(row.thumb_key),
    };
  }

  // F11：缩略图分支——webp 恒 inline；不走 Range（<img> 不发 Range，且 size_bytes 是原图尺寸）
  if (thumb && row.thumb_key) {
    try {
      const { stream, contentLength } = await getStorage().createReadStream(row.thumb_key);
      reply.header("Content-Type", "image/webp");
      reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(row.filename)}.webp"`);
      reply.header("Content-Length", contentLength);
      // F14：inline 面扩到音视频/PDF/文本后，禁 sniffing 是底线纵深——浏览器必须
      // 按声明的 Content-Type 处理，防内容嗅探把数据当 HTML 执行。
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(stream);
    } catch {
      // 缩略图字节缺失：不 404，继续回落出原图字节（UI 不因此破图）
    }
  }

  const totalSize = Number(row.size_bytes) || 0;
  const range = parseRangeHeader(rangeHeader, totalSize);
  if (range === "invalid" || (range && (range.start >= totalSize || totalSize === 0))) {
    return reply.status(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "range not satisfiable" });
  }

  try {
    const {
      stream,
      contentLength,
      totalSize: realTotal,
    } = await getStorage().createReadStream(row.storage_key, range ?? undefined);
    reply.header("Content-Type", row.mime_type || "application/octet-stream");
    const disposition = inline && INLINE_SAFE_MIME.has(row.mime_type) ? "inline" : "attachment";
    reply.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(row.filename)}"`);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", contentLength);
    // F14：禁 sniffing（inline 白名单扩容后的底线纵深，同缩略图分支）
    reply.header("X-Content-Type-Options", "nosniff");
    if (range) {
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${realTotal || totalSize}`);
      reply.status(206);
    }
    return reply.send(stream);
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
    return serveAttachment(
      app,
      reply,
      req.user.sub,
      result.rows[0],
      Boolean(query.meta),
      Boolean(query.inline),
      req.headers.range,
      Boolean(query.thumb),
    );
  });

  app.get("/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const attachmentId = (req.params as Record<string, string>).id;
    const userId = req.user.sub;
    const result = await app.pg.query<AttachmentRow>("SELECT * FROM attachments WHERE id = $1", [attachmentId]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "not found" });
    const q = req.query as Record<string, string>;
    return serveAttachment(
      app,
      reply,
      userId,
      result.rows[0],
      Boolean(q.meta),
      Boolean(q.inline),
      req.headers.range,
      Boolean(q.thumb),
    );
  });
}
