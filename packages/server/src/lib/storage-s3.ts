import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Storage } from "./storage.js";

/**
 * O4 对象存储后端：S3 协议兼容对象存储（AWS S3 / MinIO / 兼容网关）。
 *
 * 设计约束：
 * - 只依赖 Storage 接口（save/read/remove/publicUrl），上传/下载/删除路由零改动；
 * - 私有桶不暴露签名密钥：S3_PUBLIC_BASE_URL 未配置时 publicUrl 返回服务端代理路径
 *   （/api/attachments/by-key?key=…，由路由做鉴权 + 访问控制后代理字节）；
 * - 构造函数可注入 S3ClientLike 供单测（fake client 记录命令 / 预设响应），
 *   不注入时用 @aws-sdk/client-s3 的 S3Client 连接真实端点；
 * - 连接参数校验与 config.ts 的 collectInsecureConfig 双保险：后者在生产启动时
 *   拦截缺失项，此处保证任何调用方构造即失败（含测试/脚本）。
 */

/** S3Client 的最小结构子集：仅 send()。测试可注入记录命令的 fake。 */
export interface S3ClientLike {
  send(command: unknown): Promise<any>;
}

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

/** 判断错误是否为「对象不存在」（SDK NoSuchKey 名 / 404 状态码，兼容 fake 抛出的简装错误）。 */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; statusCode?: number; $metadata?: { httpStatusCode?: number } };
  if (e.name === "NoSuchKey") return true;
  if (e.statusCode === 404) return true;
  return e.$metadata?.httpStatusCode === 404;
}

export class S3Storage implements Storage {
  private readonly bucket: string;
  private readonly client: S3ClientLike;
  private readonly publicBaseUrl: string;

  constructor(opts: S3StorageOptions, client?: S3ClientLike) {
    const missing: string[] = [];
    if (!opts.endpoint) missing.push("S3_ENDPOINT");
    if (!opts.bucket) missing.push("S3_BUCKET");
    if (!opts.accessKey) missing.push("S3_ACCESS_KEY");
    if (!opts.secretKey) missing.push("S3_SECRET_KEY");
    if (missing.length > 0) {
      throw new Error(`S3 存储配置缺失：${missing.join("、")}`);
    }
    this.bucket = opts.bucket;
    this.publicBaseUrl = opts.publicBaseUrl || "";
    this.client =
      client ??
      new S3Client({
        endpoint: opts.endpoint,
        region: opts.region,
        credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
        forcePathStyle: opts.forcePathStyle,
      });
  }

  async save(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async read(key: string): Promise<Buffer> {
    let res: any;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) throw new Error(`object not found: ${key}`);
      throw err;
    }
    // 兼容 fake/网关返回的简装响应：顶层 statusCode 404 亦视为不存在
    if (res?.statusCode === 404) throw new Error(`object not found: ${key}`);
    const body = res?.Body;
    // 优先走 SDK 流式读取路径（transformToByteArray），兼容 Body 直接是 Buffer 的响应
    if (typeof body?.transformToByteArray === "function") {
      return Buffer.from(await body.transformToByteArray());
    }
    if (Buffer.isBuffer(body)) return body;
    throw new Error(`object body missing: ${key}`);
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // 幂等删除：对象不存在视为成功，其余错误向上抛
      if (!isNotFound(err)) throw err;
    }
  }

  publicUrl(key: string): string {
    const encodedPath = key.split("/").map(encodeURIComponent).join("/");
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/+$/, "")}/${encodedPath}`;
    }
    return `/api/attachments/by-key?key=${encodeURIComponent(key)}`;
  }
}
