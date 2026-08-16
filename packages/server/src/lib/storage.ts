import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { config } from "./config.js";

/**
 * O4 对象存储抽象。
 *
 * 路由只依赖 Storage 接口（save/read/remove/publicUrl），后端可插拔：
 * - local：本地磁盘（现状，uploads/ 目录，经 /files/ 静态路由鉴权后直出）；
 * - s3/minio：对象存储（lib/storage-s3.ts，MinIO/S3 协议兼容）。
 * 按 STORAGE_BACKEND 选择；切换后端后上传/下载/删除全链路路由代码零改动。
 */

export interface Storage {
  /** 保存对象（key 由 newStorageKey 生成）。 */
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  /** 幂等删除：对象不存在视为成功。 */
  remove(key: string): Promise<void>;
  /**
   * 浏览器可直接访问的同源 URL：
   * - local：/files/<key>（@fastify/static + onRequest 鉴权）；
   * - s3：配置了 S3_PUBLIC_BASE_URL 时为 <base>/<key>（公共桶/CDN 直链），
   *   否则为 /api/attachments/by-key?key=<encodeURIComponent(key)>（服务端鉴权 +
   *   访问控制后代理字节，私有桶不暴露签名密钥）。
   */
  publicUrl(key: string): string;
}

/**
 * 文件名净化：去路径分隔符与控制字符、截断到 128 字符。
 * 防目录穿越（key 会被拼进本地路径 / 对象键）与日志注入。
 */
export function sanitizeFilename(name: string): string {
  const clean = String(name || "file")
    .replace(/[\\/]/g, "_")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符范围是刻意为之（去 NUL/换行/ESC 等）
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 128);
  if (clean === "." || clean === ".." || clean === "") return "file";
  return clean;
}

/**
 * 统一 storage_key 生成：`<uuid>/<净化文件名>`。
 * uuid 前缀保证唯一（同秒并发/重名不冲突），文件名仅供人类可读。
 */
export function newStorageKey(filename: string): string {
  return `${randomUUID()}/${sanitizeFilename(filename)}`;
}

class LocalDiskStorage implements Storage {
  constructor(
    private baseDir: string,
    private publicPrefix = "/files",
  ) {}

  private pathFor(key: string): string {
    const base = resolve(this.baseDir);
    const full = resolve(base, key);
    // 必须落在 baseDir 内：前缀比较加分隔符防 /uploads 误匹配 /uploads_evil
    if (full !== base && !full.startsWith(base + sep)) throw new Error("invalid storage key");
    return full;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => {});
  }

  publicUrl(key: string): string {
    return this.publicPrefix + "/" + key.split("/").map(encodeURIComponent).join("/");
  }
}

export const UPLOAD_DIR = join(process.cwd(), "uploads");

/** 文件上传 MIME 类型白名单（从环境变量读取，逗号分隔） */
const _allowedMimeTypes = config.ALLOWED_MIME_TYPES;

export function isAllowedMimeType(mime: string): boolean {
  return _allowedMimeTypes.includes(mime);
}

// ---- 后端选择（O4） ----

export type StorageBackendKind = "local" | "s3";

/** 纯函数：STORAGE_BACKEND 取值归一化（local 默认；s3/minio 归一到 s3；未知值降级 local）。 */
export function resolveStorageBackend(raw: string | undefined): StorageBackendKind {
  const v = String(raw || "local").toLowerCase();
  if (v === "s3" || v === "minio") return "s3";
  return "local";
}

/**
 * 单例：按配置在模块加载时构建（顶层 await）。
 * 默认 local 不加载 S3 SDK；s3 后端动态 import lib/storage-s3.js。
 */
const backend: StorageBackendKind = resolveStorageBackend(config.STORAGE_BACKEND);

let storageInstance: Storage;
if (backend === "s3") {
  const { S3Storage } = await import("./storage-s3.js");
  storageInstance = new S3Storage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE === "1",
    publicBaseUrl: config.S3_PUBLIC_BASE_URL,
  });
} else {
  storageInstance = new LocalDiskStorage(UPLOAD_DIR, "/files");
}

export function getStorage(): Storage {
  return storageInstance;
}
