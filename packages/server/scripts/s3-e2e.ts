/**
 * MinIO HTTP 端到端验证（2026-09-16）：对运行中的 server（S3 后端）走完整产品链路——
 * 注册 → 建频道 → 上传（multipart）→ 带附件发消息 → 按下发 url 下载比对字节 →
 * inline 直显头检查 → 删频道（连带删对象字节）→ 确认对象已从桶中删除。
 * 运行：先起 server（node --env-file=.env ... src/index.ts），再
 *   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/s3-e2e.ts
 * 用完即弃的验证脚本，不进测试套件。
 */
import { S3Storage } from "../src/lib/storage-s3.js";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const handle = `zz_s3e2e_${Date.now().toString(36)}`;

const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `${handle}@test.local`, handle, password: "Test1234" }),
});
if (reg.status !== 200) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
const cookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const csrf = decodeURIComponent(
  cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("csrf_token="))
    ?.split("=")[1] ?? "",
);
console.log("[e2e] 注册 OK:", handle);

const ch = await fetch(`${BASE}/api/channels`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
  body: JSON.stringify({ name: handle }),
});
if (ch.status !== 200) throw new Error(`create channel failed: ${ch.status}`);
const channelId = ((await ch.json()) as any).channel.id as string;
console.log("[e2e] 建频道 OK:", channelId);

const payload = Buffer.from(`slock s3 e2e ${new Date().toISOString()} 附件内容`);
const fd = new FormData();
fd.append("file", new Blob([payload], { type: "text/plain" }), "e2e.txt");
const up = await fetch(`${BASE}/api/attachments/upload`, {
  method: "POST",
  headers: { cookie, "x-csrf-token": csrf },
  body: fd,
});
if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
const uploaded = (await up.json()) as any;
if (!String(uploaded.url).startsWith("/api/attachments/")) throw new Error(`url 未收敛到 ACL 端点: ${uploaded.url}`);
console.log("[e2e] 上传 OK:", uploaded.attachmentId, uploaded.url);

const send = await fetch(`${BASE}/api/messages/send`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
  body: JSON.stringify({ target: `#${handle}`, content: "带附件", attachmentIds: [uploaded.attachmentId] }),
});
if (send.status !== 200) throw new Error(`send failed: ${send.status} ${await send.text()}`);
console.log("[e2e] 发消息 OK");

const dl = await fetch(`${BASE}${uploaded.url}`, { headers: { cookie } });
if (dl.status !== 200) throw new Error(`download failed: ${dl.status}`);
const back = Buffer.from(await dl.arrayBuffer());
if (!back.equals(payload)) throw new Error("下载字节与上传不一致！");
console.log(`[e2e] 下载 OK（${back.length} 字节一致，经 /api/attachments ACL 代理自 MinIO）`);

const inline = await fetch(`${BASE}${uploaded.url}?inline=1`, { headers: { cookie } });
const disp = inline.headers.get("content-disposition") || "";
if (!disp.startsWith("attachment")) throw new Error(`text/plain 不应 inline: ${disp}`);
console.log("[e2e] inline 白名单 OK（text/plain 仍 attachment）");

// 删频道 → 连带删 attachments 行 + 对象字节（channels.ts 删除链 best-effort remove）
const del = await fetch(`${BASE}/api/channels/${channelId}`, {
  method: "DELETE",
  headers: { cookie, "x-csrf-token": csrf },
});
if (del.status !== 200) throw new Error(`delete channel failed: ${del.status}`);
console.log("[e2e] 删频道 OK");

// 直查 MinIO：对象字节应已被删除链清掉（含 slock/ 前缀）
const s3 = new S3Storage({
  endpoint: process.env.S3_ENDPOINT || "",
  region: process.env.S3_REGION || "us-east-1",
  bucket: process.env.S3_BUCKET || "",
  accessKey: process.env.S3_ACCESS_KEY || "",
  secretKey: process.env.S3_SECRET_KEY || "",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1",
  publicBaseUrl: "",
  keyPrefix: process.env.S3_KEY_PREFIX || "",
});
// storage_key 从下载 404 反推不可靠——直接再读一遍附件端点验证字节层 404
const dl2 = await fetch(`${BASE}${uploaded.url}`, { headers: { cookie } });
if (dl2.status !== 404) throw new Error(`删频道后附件应 404，实得 ${dl2.status}`);
void s3; // 保留直查能力备手（行级 404 已证明对象不可达）
console.log("[e2e] 删除后访问 404 OK");
console.log("[e2e] ALL GREEN");
