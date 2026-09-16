import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, BASE, cleanupTestData, closeSql, registerUser, sql, type TestUser, uniqHandle } from "./helpers.js";

// O4 存储路由加固的黑盒回归测试：
// 1. 上传返回 attachmentId + /api/attachments/<id> url（F7 收敛后为 ACL 端点），带 cookie 可直接下载同字节
// 2. 路径穿越文件名被净化（storage_key 无 .. 段）
// 3. 超过 MAX_UPLOAD_SIZE 的文件 413
// 4. 访问控制：非上传者 403；/by-key 与 /:id 走同一鉴权代理
// 5. 删除频道连带清理不再被引用的附件行与对象字节
// 6. F7：旧 /files/ capability 链接 410；?inline=1 仅对安全图片 MIME 放行 inline 直显

let alice: TestUser;
let bob: TestUser;

function csrfOf(user: TestUser): string {
  return (
    user.cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("csrf_token="))
      ?.split("=")[1] || ""
  );
}

async function uploadFile(user: TestUser, filename: string, body: BlobPart | Buffer, mime = "text/plain") {
  const fd = new FormData();
  fd.append("file", new Blob([body], { type: mime }), filename);
  const res = await fetch(`${BASE}/api/attachments/upload`, {
    method: "POST",
    headers: { cookie: user.cookie, "x-csrf-token": decodeURIComponent(csrfOf(user)) },
    body: fd,
  });
  const data = (await res.json().catch(() => null)) as any;
  return { status: res.status, data };
}

async function storageKeyOf(attachmentId: string): Promise<string> {
  const rows = await sql`SELECT storage_key FROM attachments WHERE id = ${attachmentId}`;
  return String(rows[0]?.storage_key || "");
}

async function downloadBytes(user: TestUser, path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: user.cookie } });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  alice = await registerUser();
  bob = await registerUser();
});

afterAll(async () => {
  await cleanupTestData();
  // 附件行不在 cleanupTestData 的清理范围内（消息引用已先清掉），补删本测试上传的孤儿行
  await sql`DELETE FROM attachments WHERE uploader_id::text = ANY(${[alice.userId, bob.userId]})`;
  await closeSql();
});

describe("attachments: O4 存储路由加固", () => {
  it("上传小文件返回 attachmentId 与 /api/attachments/<id> url（F7），带 cookie 下载字节一致", async () => {
    const up = await uploadFile(alice, "hello.txt", "hello attachment");
    expect(up.status).toBe(200);
    expect(up.data.attachmentId).toBeTruthy();
    expect(up.data.url).toBe("/api/attachments/" + up.data.attachmentId);
    const dl = await downloadBytes(alice, up.data.url);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe("hello attachment");
  });

  it("F7：旧 /files/ capability 链接 410（观察期），不再出字节", async () => {
    const up = await uploadFile(alice, "legacy.txt", "legacy bytes");
    expect(up.status).toBe(200);
    const key = await storageKeyOf(up.data.attachmentId);
    expect(key.length).toBeGreaterThan(0);
    // 即使持有效 cookie + 知道完整 storage_key，/files/ 也不再出字节
    const res = await fetch(`${BASE}/files/${key}`, { headers: { cookie: alice.cookie } });
    expect(res.status).toBe(410);
  });

  it("F7：?inline=1 仅对安全图片 MIME 放行 inline 直显，其余仍 attachment 下载", async () => {
    const img = await uploadFile(alice, "pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    expect(img.status).toBe(200);
    const imgInline = await fetch(`${BASE}${img.data.url}?inline=1`, { headers: { cookie: alice.cookie } });
    expect(imgInline.status).toBe(200);
    expect(imgInline.headers.get("content-disposition")).toMatch(/^inline;/);
    // 裸 url（不带 inline）仍是强制下载
    const imgDl = await fetch(`${BASE}${img.data.url}`, { headers: { cookie: alice.cookie } });
    expect(imgDl.headers.get("content-disposition")).toMatch(/^attachment;/);

    // PDF 即使带 inline=1 也强制下载（不在 INLINE_SAFE_MIME；防非图片内容在站内嵌渲染）
    const pdf = await uploadFile(alice, "doc.pdf", "%PDF-1.4 fake", "application/pdf");
    expect(pdf.status).toBe(200);
    const pdfInline = await fetch(`${BASE}${pdf.data.url}?inline=1`, { headers: { cookie: alice.cookie } });
    expect(pdfInline.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("路径穿越文件名被净化：storage_key 无 .. 段", async () => {
    const up = await uploadFile(alice, "../evil.txt", "traversal");
    expect(up.status).toBe(200);
    const key = await storageKeyOf(up.data.attachmentId);
    expect(key.length).toBeGreaterThan(0);
    expect(key.split("/").some((seg) => seg === ".." || seg === ".")).toBe(false);
    expect(key.includes("/../")).toBe(false);
  });

  it("超过 MAX_UPLOAD_SIZE 的文件 413", async () => {
    const up = await uploadFile(alice, "big.txt", Buffer.alloc(11 * 1024 * 1024, 0));
    expect(up.status).toBe(413);
    expect(up.data.error).toMatch(/file too large/);
  });

  it("访问控制：非上传者 403，上传者 200；/by-key 与 /:id 走同一鉴权代理", async () => {
    const up = await uploadFile(alice, "secret.txt", "secret bytes");
    expect(up.status).toBe(200);
    const id = up.data.attachmentId as string;
    const key = await storageKeyOf(id);
    expect(key.length).toBeGreaterThan(0);

    // 尚未挂到任何消息：仅上传者可访问
    expect((await api(`/api/attachments/${id}`, { cookie: bob.cookie })).status).toBe(403);
    const mine = await downloadBytes(alice, `/api/attachments/${id}`);
    expect(mine.status).toBe(200);
    expect(mine.text).toBe("secret bytes");

    // 挂到公开频道后，/by-key 对上传者与频道成员都出字节（同一 access helper）
    const name = uniqHandle();
    const ch = await api("/api/channels", {
      method: "POST",
      cookie: alice.cookie,
      body: { name, visibility: "public" },
    });
    expect(ch.status).toBe(200);
    const send = await api("/api/messages/send", {
      method: "POST",
      cookie: alice.cookie,
      body: { target: `#${name}`, content: "with attachment", attachmentIds: [id] },
    });
    expect(send.status).toBe(200);
    for (const user of [alice, bob]) {
      const byKey = await downloadBytes(user, `/api/attachments/by-key?key=${encodeURIComponent(key)}`);
      expect(byKey.status).toBe(200);
      expect(byKey.text).toBe("secret bytes");
    }

    // 不存在的 by-key → 404
    const missing = await api(
      `/api/attachments/by-key?key=${encodeURIComponent("00000000-0000-0000-0000-000000000000/nope.txt")}`,
      { cookie: alice.cookie },
    );
    expect(missing.status).toBe(404);
  });

  it("F9：流式下载支持 Range——206/Content-Range/Accept-Ranges，越界 416", async () => {
    const up = await uploadFile(alice, "digits.txt", "0123456789");
    expect(up.status).toBe(200);
    const url = up.data.url as string;

    // 全量：200 + Accept-Ranges + Content-Length（F9 起恒发）
    const full = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie } });
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("10");
    expect(await full.text()).toBe("0123456789");

    // 闭区间 bytes=0-3 → 206 + 前 4 字节
    const head = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie, range: "bytes=0-3" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(head.headers.get("content-length")).toBe("4");
    expect(await head.text()).toBe("0123");

    // 开放区间 bytes=6- → 到末尾；bytes=0-99 的 end 截断到 totalSize-1
    const tail = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie, range: "bytes=6-" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 6-9/10");
    expect(await tail.text()).toBe("6789");

    const clamped = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie, range: "bytes=0-99" } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("content-range")).toBe("bytes 0-9/10");
    expect(await clamped.text()).toBe("0123456789");

    // 后缀区间 bytes=-4 → 最后 4 字节
    const suffix = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie, range: "bytes=-4" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 6-9/10");
    expect(await suffix.text()).toBe("6789");

    // 越界 start ≥ totalSize → 416 + Content-Range: bytes */10
    const oob = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie, range: "bytes=100-200" } });
    expect(oob.status).toBe(416);
    expect(oob.headers.get("content-range")).toBe("bytes */10");

    // 非法区间（start > end）→ 416；非 bytes 单位 → 忽略走全量 200
    const inverted = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie, range: "bytes=5-3" } });
    expect(inverted.status).toBe(416);
    const junk = await fetch(`${BASE}${url}`, { headers: { cookie: alice.cookie, range: "items=0-3" } });
    expect(junk.status).toBe(200);
    expect(await junk.text()).toBe("0123456789");
  });

  it("F10：同内容去重——两次上传共享 storage_key；删频道不误删仍被引用的字节", async () => {
    // 相同字节上传两次（文件名刻意不同）：去重只认内容
    const up1 = await uploadFile(alice, "dup-a.txt", "dedup me f10");
    const up2 = await uploadFile(bob, "dup-b.txt", "dedup me f10");
    expect(up1.status).toBe(200);
    expect(up2.status).toBe(200);
    const [id1, id2] = [up1.data.attachmentId as string, up2.data.attachmentId as string];
    expect(id1).not.toBe(id2);
    const [key1, key2] = [await storageKeyOf(id1), await storageKeyOf(id2)];
    expect(key1).toBe(key2); // 字节只存一份
    // sha256 列已写
    const rows = await sql`SELECT sha256 FROM attachments WHERE id = ${id1}`;
    expect(String(rows[0]?.sha256)).toMatch(/^[0-9a-f]{64}$/);

    // alice 的副本挂到频道 A，bob 的副本挂到频道 B
    const mkChannel = async (owner: TestUser) => {
      const name = uniqHandle();
      const ch = await api("/api/channels", { method: "POST", cookie: owner.cookie, body: { name } });
      expect(ch.status).toBe(200);
      return { id: ch.data.channel.id as string, name };
    };
    const chA = await mkChannel(alice);
    const chB = await mkChannel(bob);
    const send = (owner: TestUser, chName: string, attId: string) =>
      api("/api/messages/send", {
        method: "POST",
        cookie: owner.cookie,
        body: { target: `#${chName}`, content: "dup", attachmentIds: [attId] },
      });
    expect((await send(alice, chA.name, id1)).status).toBe(200);
    expect((await send(bob, chB.name, id2)).status).toBe(200);

    // 删频道 A：附件行 1 被清，但字节仍被行 2 引用——bob 侧照常下载
    expect((await api(`/api/channels/${chA.id}`, { method: "DELETE", cookie: alice.cookie })).status).toBe(200);
    expect((await api(`/api/attachments/${id1}`, { cookie: alice.cookie })).status).toBe(404);
    const still = await downloadBytes(bob, `/api/attachments/${id2}`);
    expect(still.status).toBe(200);
    expect(still.text).toBe("dedup me f10");

    // 收尾：删频道 B 后字节才真正消失
    expect((await api(`/api/channels/${chB.id}`, { method: "DELETE", cookie: bob.cookie })).status).toBe(200);
    expect(existsSync(join(process.cwd(), "uploads", key1))).toBe(false);
  });

  it("F11：图片上传生成 webp 缩略图——?thumb=1 inline 直出，消息载荷带 thumbnailUrl", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    const up = await uploadFile(alice, "photo.png", png, "image/png");
    expect(up.status).toBe(200);
    const id = up.data.attachmentId as string;

    // DB：thumb_key 已写且指向派生键
    const rows = await sql`SELECT thumb_key, storage_key FROM attachments WHERE id = ${id}`;
    expect(String(rows[0]?.thumb_key)).toBe(`${rows[0]?.storage_key}.thumb.webp`);

    // ?thumb=1 → webp + inline；尺寸 ≤400px；体积显著小于原图
    const th = await fetch(`${BASE}/api/attachments/${id}?thumb=1`, { headers: { cookie: alice.cookie } });
    expect(th.status).toBe(200);
    expect(th.headers.get("content-type")).toBe("image/webp");
    expect(th.headers.get("content-disposition")).toMatch(/^inline;/);
    const thumbBuf = Buffer.from(await th.arrayBuffer());
    expect(thumbBuf.length).toBeLessThan(png.length);
    const meta = await sharp(thumbBuf).metadata();
    expect(Math.max(meta.width || 0, meta.height || 0)).toBeLessThanOrEqual(400);

    // 消息载荷带 thumbnailUrl（频道 history 走 attachmentsJson 聚合）
    const name = uniqHandle();
    const ch = await api("/api/channels", { method: "POST", cookie: alice.cookie, body: { name } });
    expect(ch.status).toBe(200);
    const send = await api("/api/messages/send", {
      method: "POST",
      cookie: alice.cookie,
      body: { target: `#${name}`, content: "img", attachmentIds: [id] },
    });
    expect(send.status).toBe(200);
    const hist = await api(`/api/messages/history?channel=${encodeURIComponent("#" + name)}`, {
      cookie: alice.cookie,
    });
    const att = hist.data.messages?.[0]?.attachments?.[0];
    expect(att?.thumbnailUrl).toBe(`/api/attachments/${id}?thumb=1`);

    // 非图片不生成缩略图（thumb_key NULL、载荷无 thumbnailUrl）
    const txt = await uploadFile(alice, "note.txt", "plain text", "text/plain");
    const t2 = await sql`SELECT thumb_key FROM attachments WHERE id = ${txt.data.attachmentId}`;
    expect(t2[0]?.thumb_key).toBeNull();

    // F10 去重与 F11 联动：同图二次上传复用同一 thumb_key
    const up2 = await uploadFile(bob, "photo-copy.png", png, "image/png");
    const t3 = await sql`SELECT thumb_key FROM attachments WHERE id = ${up2.data.attachmentId}`;
    expect(t3[0]?.thumb_key).toBe(rows[0]?.thumb_key);
  });

  it("删除频道连带清理不再被引用的附件行与对象字节", async () => {
    const name = uniqHandle();
    const ch = await api("/api/channels", { method: "POST", cookie: alice.cookie, body: { name } });
    expect(ch.status).toBe(200);
    const channelId = ch.data.channel.id as string;

    const up = await uploadFile(alice, "doomed.txt", "doomed bytes");
    expect(up.status).toBe(200);
    const id = up.data.attachmentId as string;
    const key = await storageKeyOf(id);
    expect(key.length).toBeGreaterThan(0);

    const send = await api("/api/messages/send", {
      method: "POST",
      cookie: alice.cookie,
      body: { target: `#${name}`, content: "with attachment", attachmentIds: [id] },
    });
    expect(send.status).toBe(200);

    const del = await api(`/api/channels/${channelId}`, { method: "DELETE", cookie: alice.cookie });
    expect(del.status).toBe(200);

    // 附件行已被删除链清理
    expect((await api(`/api/attachments/${id}`, { cookie: alice.cookie })).status).toBe(404);
    const rows = await sql`SELECT id FROM attachments WHERE id = ${id}`;
    expect(rows.length).toBe(0);
    // 本地后端的对象字节也应被 best-effort 删除（uploads/ 与 server 同 cwd）
    expect(existsSync(join(process.cwd(), "uploads", key))).toBe(false);
  });
});
