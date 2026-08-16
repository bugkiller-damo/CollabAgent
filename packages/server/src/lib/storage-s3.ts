import type { Storage } from "./storage.js";

/**
 * O4 子任务 A 的实现目标：S3/MinIO 对象存储后端。
 *
 * ⚠️ 当前为契约占位（编译通过、运行时抛错）。子任务 A 用 @aws-sdk/client-s3
 * 实现全部方法后删除本注释块。storage.ts 的顶层 await 会动态 import 本模块，
 * 仅当 STORAGE_BACKEND=s3|minio 时加载，默认 local 部署不引入 S3 SDK。
 */

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  /** 可选：公共桶/CDN 直链基地址；缺省时 publicUrl 返回 /api/attachments/by-key?key=<encoded> */
  publicBaseUrl: string;
}

export class S3Storage implements Storage {
  constructor(_opts: S3StorageOptions) {
    throw new Error("S3Storage not implemented yet (O4 子任务 A)");
  }

  async save(_key: string, _data: Buffer): Promise<void> {
    throw new Error("not implemented");
  }

  async read(_key: string): Promise<Buffer> {
    throw new Error("not implemented");
  }

  async remove(_key: string): Promise<void> {
    throw new Error("not implemented");
  }

  publicUrl(_key: string): string {
    throw new Error("not implemented");
  }
}
