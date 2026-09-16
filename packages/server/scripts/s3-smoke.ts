/**
 * MinIO 落地冒烟（2026-09-16）：直接实例化 S3Storage（读 --env-file 注入的 S3_* env），
 * 对真实 MinIO 做 save → read（字节比对）→ remove → remove 幂等 全链路。
 * 运行：node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/s3-smoke.ts
 * 用完即弃的验证脚本，不进测试套件。
 */
import { S3Storage } from "../src/lib/storage-s3.js";

const storage = new S3Storage({
  endpoint: process.env.S3_ENDPOINT || "",
  region: process.env.S3_REGION || "us-east-1",
  bucket: process.env.S3_BUCKET || "",
  accessKey: process.env.S3_ACCESS_KEY || "",
  secretKey: process.env.S3_SECRET_KEY || "",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1",
  publicBaseUrl: "",
  keyPrefix: process.env.S3_KEY_PREFIX || "",
});

const key = `smoke/${Date.now()}-hello.txt`;
const payload = Buffer.from(`slock minio smoke ${new Date().toISOString()} 世界`);

console.log(
  `[smoke] endpoint=${process.env.S3_ENDPOINT} bucket=${process.env.S3_BUCKET} prefix=${process.env.S3_KEY_PREFIX}`,
);
console.log(`[smoke] logical key=${key}（真实对象应落在 ${(process.env.S3_KEY_PREFIX || "") + key}）`);

await storage.save(key, payload);
console.log("[smoke] save OK");

const back = await storage.read(key);
if (!back.equals(payload)) throw new Error("read-back bytes mismatch!");
console.log(`[smoke] read OK（${back.length} 字节，内容一致）`);

await storage.remove(key);
console.log("[smoke] remove OK");

await storage.remove(key); // 幂等：删不存在对象不抛
console.log("[smoke] remove 幂等 OK");

let threw = false;
try {
  await storage.read(key);
} catch (err: any) {
  threw = /not found/i.test(err?.message ?? "");
}
if (!threw) throw new Error("read after remove should throw not found");
console.log("[smoke] remove 后读取正确报 not found");
console.log("[smoke] ALL GREEN");
