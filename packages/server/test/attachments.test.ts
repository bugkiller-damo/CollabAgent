import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, BASE, cleanupTestData, closeSql, registerUser, sql, type TestUser, uniqHandle } from "./helpers.js";

// O4 存储路由加固的黑盒回归测试：
// 1. 上传返回 attachmentId + /files/ url，带 cookie 可直接下载同字节
// 2. 路径穿越文件名被净化（storage_key 无 .. 段）
// 3. 超过 MAX_UPLOAD_SIZE 的文件 413
// 4. 访问控制：非上传者 403；/by-key 与 /:id 走同一鉴权代理
// 5. 删除频道连带清理不再被引用的附件行与对象字节

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
  it("上传小文件返回 attachmentId 与 /files/ url，带 cookie 下载字节一致", async () => {
    const up = await uploadFile(alice, "hello.txt", "hello attachment");
    expect(up.status).toBe(200);
    expect(up.data.attachmentId).toBeTruthy();
    expect(up.data.url).toMatch(/^\/files\//);
    const dl = await downloadBytes(alice, up.data.url);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe("hello attachment");
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
