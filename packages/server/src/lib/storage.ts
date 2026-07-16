import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.js";

export interface Storage {
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  publicUrl(key: string): string;
}

class LocalDiskStorage implements Storage {
  constructor(private baseDir: string, private publicPrefix = "/files") {}

  private pathFor(key: string): string {
    const full = resolve(this.baseDir, key);
    if (!full.startsWith(resolve(this.baseDir))) throw new Error("invalid storage key");
    return full;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async read(key: string): Promise<Buffer> { return readFile(this.pathFor(key)); }

  async remove(key: string): Promise<void> { await unlink(this.pathFor(key)).catch(() => {}); }

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

let storageInstance: Storage | null = null;

export function getStorage(): Storage {
  if (storageInstance) return storageInstance;
  storageInstance = new LocalDiskStorage(UPLOAD_DIR, "/files");
  return storageInstance;
}
