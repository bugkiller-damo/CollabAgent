import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// 存储抽象：当前用本地磁盘实现；后续可加 MinIO/S3 实现并通过 STORAGE_DRIVER 切换
export interface Storage {
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  // 返回可直接访问的相对 URL（前端用）
  publicUrl(key: string): string;
}

class LocalDiskStorage implements Storage {
  constructor(private baseDir: string, private publicPrefix = "/files") {}

  private pathFor(key: string): string {
    // 防目录穿越：解析后必须仍在 baseDir 内
    const full = resolve(this.baseDir, key);
    if (!full.startsWith(resolve(this.baseDir))) {
      throw new Error("invalid storage key");
    }
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

// 上传文件根目录（packages/server/uploads）
export const UPLOAD_DIR = join(process.cwd(), "uploads");

let storageInstance: Storage | null = null;

export function getStorage(): Storage {
  if (storageInstance) return storageInstance;
  // 预留：if (process.env.STORAGE_DRIVER === "minio") storageInstance = new MinioStorage(...)
  storageInstance = new LocalDiskStorage(UPLOAD_DIR, "/files");
  return storageInstance;
}
