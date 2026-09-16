import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Storage, StorageRange, StorageReadStream } from "./storage.js";

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
  /**
   * 可选：对象 key 前缀（多系统共享桶时的目录隔离，如 "slock/"）。
   * 只在存储层拼接——DB 的 storage_key 与上层路由始终看到不带前缀的逻辑 key；
   * publicUrl 的 CDN 直链含前缀（真实对象路径），by-key 代理路径不含（key 参数是逻辑 key）。
   */
  keyPrefix?: string;
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
  private readonly keyPrefix: string;

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
    // 前缀归一：去首尾斜杠后补单尾斜杠；空值保持空前缀（不污染 key）
    const rawPrefix = (opts.keyPrefix || "").replace(/^\/+|\/+$/g, "");
    this.keyPrefix = rawPrefix ? rawPrefix + "/" : "";
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
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.keyPrefix + key, Body: data }));
  }

  async read(key: string): Promise<Buffer> {
    let res: any;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.keyPrefix + key }));
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

  /**
   * F9 流式读取：range 时发 S3 Range 头（bytes=start-end），206 响应的
   * Content-Range（"bytes start-end/total"）解析出 totalSize；全量时取 ContentLength。
   */
  async createReadStream(key: string, range?: StorageRange): Promise<StorageReadStream> {
    const input: { Bucket: string; Key: string; Range?: string } = {
      Bucket: this.bucket,
      Key: this.keyPrefix + key,
    };
    if (range) input.Range = `bytes=${range.start}-${range.end}`;
    let res: any;
    try {
      res = await this.client.send(new GetObjectCommand(input));
    } catch (err) {
      if (isNotFound(err)) throw new Error(`object not found: ${key}`);
      throw err;
    }
    if (res?.statusCode === 404) throw new Error(`object not found: ${key}`);
    const body = res?.Body;
    // 真实 SDK：Body 即 Node Readable，零拷贝直发；fake/网关简装响应兼容 Buffer / transformToByteArray
    let stream: Readable;
    if (body instanceof Readable) {
      stream = body;
    } else if (Buffer.isBuffer(body)) {
      stream = Readable.from(body);
    } else if (typeof body?.transformToByteArray === "function") {
      stream = Readable.from(Buffer.from(await body.transformToByteArray()));
    } else {
      throw new Error(`object body missing: ${key}`);
    }
    const totalFromRange = /\/(\d+)\s*$/.exec(String(res?.ContentRange || ""))?.[1];
    const totalSize = totalFromRange ? Number(totalFromRange) : Number(res?.ContentLength ?? 0);
    const contentLength = Number(res?.ContentLength ?? totalSize);
    return { stream, contentLength, totalSize };
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyPrefix + key }));
    } catch (err) {
      // 幂等删除：对象不存在视为成功，其余错误向上抛
      if (!isNotFound(err)) throw err;
    }
  }

  publicUrl(key: string): string {
    const encodedPath = key.split("/").map(encodeURIComponent).join("/");
    if (this.publicBaseUrl) {
      // CDN 直链指向真实对象路径（含前缀）
      const encodedPrefix = this.keyPrefix.split("/").filter(Boolean).map(encodeURIComponent).join("/");
      return `${this.publicBaseUrl.replace(/\/+$/, "")}/${encodedPrefix ? encodedPrefix + "/" : ""}${encodedPath}`;
    }
    // by-key 代理：key 参数是逻辑 key（无前缀），read 时存储层内部补前缀
    return `/api/attachments/by-key?key=${encodeURIComponent(key)}`;
  }
}
