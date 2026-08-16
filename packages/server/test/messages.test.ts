import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("messages: 发送 / 列取 / 编辑 / 搜索 / 反应 / 删除", () => {
  let uid: string, ck: string, cs: string;

  beforeAll(async () => {
    const u = await registerUser();
    uid = u.userId;
    ck = u.cookie;
    cs = u.csrf;
    const ch = await api("/api/channels/resolve?target=" + encodeURIComponent("#general"), { cookie: ck });
    if (ch.status !== 200) await api("/api/channels", { method: "POST", cookie: ck, body: { name: "general" } });
  });

  it("发送消息到频道", async () => {
    const r = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "hello" },
    });
    expect(r.status).toBe(200);
    expect(r.data.state).toBe("sent");
    expect(r.data.messageId).toBeTruthy();
  });

  it("发送 DM", async () => {
    const o = await registerUser();
    const r = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: `dm:@${o.handle}`, content: "hi" },
    });
    expect(r.status).toBe(200);
    expect(r.data.channelId).toMatch(/^dm:/);
  });

  it("空内容 400", async () => {
    const r = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "" },
    });
    expect(r.status).toBe(400);
  });

  it("不存在的频道 404", async () => {
    const r = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#nonexist_xyz", content: "x" },
    });
    expect(r.status).toBe(404);
  });

  it("列取频道消息字段完整", async () => {
    const r = await api("/api/messages?channel=" + encodeURIComponent("#general"), { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.messages.length).toBeGreaterThanOrEqual(1);
    const m = r.data.messages[0];
    expect(m).toHaveProperty("id");
    expect(m).toHaveProperty("senderId");
    expect(m).toHaveProperty("content");
    expect(m).toHaveProperty("time");
    expect(m).toHaveProperty("reactions");
    expect(m).toHaveProperty("attachments");
  });

  it("列取无 channel 参数 400", async () => {
    expect((await api("/api/messages", { cookie: ck })).status).toBe(400);
  });

  it("历史分页", async () => {
    for (let i = 0; i < 3; i++)
      await api("/api/messages/send", { method: "POST", cookie: ck, body: { target: "#general", content: `h${i}` } });
    const r = await api("/api/messages/history?channel=" + encodeURIComponent("#general") + "&limit=2", { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.messages.length).toBeLessThanOrEqual(2);
  });

  it("编辑自己的消息", async () => {
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "orig" },
    });
    const e = await api(`/api/messages/${s.data.messageId}`, {
      method: "PUT",
      cookie: ck,
      csrf: cs,
      body: { content: "edited" },
    });
    expect(e.status).toBe(200);
    expect(e.data.message.content).toBe("edited");
  });

  it("编辑他人消息 403", async () => {
    const o = await registerUser();
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "mine" },
    });
    const e = await api(`/api/messages/${s.data.messageId}`, {
      method: "PUT",
      cookie: o.cookie,
      csrf: o.csrf,
      body: { content: "hack" },
    });
    expect(e.status).toBe(403);
  });

  it("全文搜索", async () => {
    const r = await api("/api/messages/search?q=hello", { cookie: ck });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.results)).toBe(true);
    if (r.data.results.length) expect(r.data.results[0]).toHaveProperty("channelId");
  });

  it("添加表情反应", async () => {
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "react" },
    });
    const r = await api(`/api/messages/${s.data.messageId}/reactions`, {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { emoji: "👍" },
    });
    expect(r.status).toBe(200);
  });

  it("移除表情反应", async () => {
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "unreact" },
    });
    await api(`/api/messages/${s.data.messageId}/reactions`, {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { emoji: "❤️" },
    });
    const d = await api(`/api/messages/${s.data.messageId}/reactions/%E2%9D%A4%EF%B8%8F`, {
      method: "DELETE",
      cookie: ck,
      csrf: cs,
    });
    expect(d.status).toBe(200);
  });

  it("删除自己的消息", async () => {
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "del" },
    });
    const d = await api(`/api/messages/${s.data.messageId}`, { method: "DELETE", cookie: ck, csrf: cs });
    expect(d.status).toBe(200);
  });

  it("删除他人消息 403", async () => {
    const o = await registerUser();
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "notyours" },
    });
    const d = await api(`/api/messages/${s.data.messageId}`, { method: "DELETE", cookie: o.cookie, csrf: o.csrf });
    expect(d.status).toBe(403);
  });

  it("线程回复", async () => {
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "parent" },
    });
    await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "r1", threadId: s.data.messageId },
    });
    await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "r2", threadId: s.data.messageId },
    });
    const t = await api(`/api/messages/thread/${s.data.messageId}`, { cookie: ck });
    expect(t.status).toBe(200);
    expect(t.data.parent).toBeTruthy();
    expect(t.data.replies.length).toBeGreaterThanOrEqual(2);
  });

  it("不存在的线程 404", async () => {
    expect((await api("/api/messages/thread/00000000-0000-0000-0000-000000000000", { cookie: ck })).status).toBe(404);
  });
});
