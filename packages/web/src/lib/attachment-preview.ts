/**
 * F14 附件预览矩阵的纯判定逻辑（方案 docs/2026-09-16/01-file-upload-refactor-plan.md
 * 批次三）。抽成纯模块：AttachmentView.vue 只做渲染接线，判定可单测。
 *
 * 口径与 server 侧 INLINE_SAFE_MIME（routes/attachments.ts）对齐：
 * 浏览器按「非可执行内容」渲染的类型才可 inline/预览，SVG/HTML 恒排除。
 */

export type AttachmentPreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "file";

/** video/audio 仅收上传白名单内的容器（F13），其余 video/* 落 file 走下载 */
const VIDEO_MIME = new Set(["video/mp4", "video/webm"]);
const AUDIO_MIME = new Set(["audio/mpeg", "audio/ogg"]);

/** 文本预览（代码块）的大小上限：超过只给下载，避免整文件读进内存渲染 */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

/** 按附件 MIME 判定预览形态。 */
export function previewKind(mime: string): AttachmentPreviewKind {
  const m = String(mime || "");
  // SVG 恒落 file（与 server INLINE_SAFE_MIME 的 XSS 排除口径一致，防口径漂移）
  if (m === "image/svg+xml") return "file";
  if (m.startsWith("image/")) return "image";
  if (VIDEO_MIME.has(m)) return "video";
  if (AUDIO_MIME.has(m)) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m === "text/plain" || m === "application/json") return "text";
  return "file";
}

/** 是否可走文本代码块预览（kind=text 且不超大小上限）。 */
export function textPreviewable(mime: string, sizeBytes: number): boolean {
  return previewKind(mime) === "text" && Number(sizeBytes) <= TEXT_PREVIEW_MAX_BYTES;
}
