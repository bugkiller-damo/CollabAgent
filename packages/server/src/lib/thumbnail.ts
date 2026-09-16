/**
 * F11 附件缩略图（方案：docs/2026-09-16/01-file-upload-refactor-plan.md 批次二）。
 *
 * - 上传图片时生成 ≤400px webp 缩略图，存 `<storage_key>.thumb.webp`，行写 thumb_key；
 * - sharp 动态 import + 全失败降级为 null：缺二进制/坏图/不支持的格式都不阻塞上传；
 * - 本模块顶层不 import sharp——GC/频道删除只需要 thumbKeyFor 派生键，不该拉起原生库。
 */

/** 可生成缩略图的图片 MIME（sharp/libvips 预置支持）。刻意排除 SVG：见 F7 INLINE_SAFE_MIME 的 XSS 注记。 */
export const THUMBABLE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

/** 缩略图对象键派生：`<storage_key>.thumb.webp`。字节清理由主 key 的引用计数一并带出。 */
export function thumbKeyFor(storageKey: string): string {
  return `${storageKey}.thumb.webp`;
}

/** 生成 ≤400px webp 缩略图；任何失败（含 sharp 不可用）返回 null，调用方按「无缩略图」继续。 */
export async function makeThumbnail(buf: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(buf)
      .rotate()
      .resize(400, 400, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}
