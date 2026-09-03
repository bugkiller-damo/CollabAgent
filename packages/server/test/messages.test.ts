import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, uniqHandle } from "./helpers.js";

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

  it("limit 钳制：超上限按 200、负数按 1（P0.6）", async () => {
    // 此时 #general 已有数条消息
    const big = await api("/api/messages?channel=" + encodeURIComponent("#general") + "&limit=99999", { cookie: ck });
    expect(big.status).toBe(200);
    expect(big.data.messages.length).toBeLessThanOrEqual(200);
    const low = await api("/api/messages?channel=" + encodeURIComponent("#general") + "&limit=-5", { cookie: ck });
    expect(low.status).toBe(200);
    expect(low.data.messages.length).toBe(1);
  });

  it("history limit 钳制：超上限按 200、负数按 1（P0.6）", async () => {
    const big = await api("/api/messages/history?channel=" + encodeURIComponent("#general") + "&limit=99999", {
      cookie: ck,
    });
    expect(big.status).toBe(200);
    expect(big.data.messages.length).toBeLessThanOrEqual(200);
    const low = await api("/api/messages/history?channel=" + encodeURIComponent("#general") + "&limit=-5", {
      cookie: ck,
    });
    expect(low.status).toBe(200);
    expect(low.data.messages.length).toBe(1);
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

describe("P1.33: threadId 校验 / content 上限 / 移出私有频道后禁改删", () => {
  it("/send threadId：非 UUID / 不存在 / 跨频道 400，本频道合法 200", async () => {
    const a = await registerUser();
    const chA = "th_a_" + uniqHandle();
    const chB = "th_b_" + uniqHandle();
    await api("/api/channels", { method: "POST", cookie: a.cookie, body: { name: chA } });
    await api("/api/channels", { method: "POST", cookie: a.cookie, body: { name: chB } });
    const parent = await api("/api/messages/send", {
      method: "POST",
      cookie: a.cookie,
      body: { target: "#" + chA, content: "parent" },
    });
    expect(parent.status).toBe(200);
    const pid = parent.data.messageId;
    const send = (target: string, threadId: string) =>
      api("/api/messages/send", { method: "POST", cookie: a.cookie, body: { target, content: "r", threadId } });
    // 非 UUID（此前 22P02 cast 500）
    expect((await send("#" + chA, "not-a-uuid")).status).toBe(400);
    // 不存在的合法 UUID（此前撞 thread_id FK 500）
    expect((await send("#" + chA, "00000000-0000-0000-0000-000000000000")).status).toBe(400);
    // 跨频道（拿 chA 的父消息去 chB 回——此前跨频道线程错乱）
    expect((await send("#" + chB, pid)).status).toBe(400);
    // 本频道合法
    expect((await send("#" + chA, pid)).status).toBe(200);
  });

  it("content 超长 400（send 与 edit 同口径）", async () => {
    const a = await registerUser();
    const over = "x".repeat(10_001);
    expect(
      (
        await api("/api/messages/send", {
          method: "POST",
          cookie: a.cookie,
          body: { target: "#general", content: over },
        })
      ).status,
    ).toBe(400);
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: a.cookie,
      body: { target: "#general", content: "ok" },
    });
    expect(s.status).toBe(200);
    expect(
      (await api(`/api/messages/${s.data.messageId}`, { method: "PUT", cookie: a.cookie, body: { content: over } }))
        .status,
    ).toBe(400);
  });

  it("被移出私有频道后不得编辑/删除自己的旧消息；公开频道不受影响", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const chName = "kick_" + uniqHandle();
    const ch = (
      await api("/api/channels", { method: "POST", cookie: owner.cookie, body: { name: chName, type: "private" } })
    ).data.channel;
    // 邀请 member → member 发一条 → owner 把 member 移出
    expect(
      (
        await api(`/api/channels/${ch.id}/invite`, {
          method: "POST",
          cookie: owner.cookie,
          body: { handle: member.handle },
        })
      ).status,
    ).toBe(200);
    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: member.cookie,
      body: { target: "#" + chName, content: "mine" },
    });
    expect(s.status).toBe(200);
    expect(
      (await api(`/api/channels/${ch.id}/members/${member.userId}`, { method: "DELETE", cookie: owner.cookie })).status,
    ).toBe(200);
    // 移出后：改/删自己的旧消息均 403（此前只查 sender 归属，仍可改删并触发广播）
    expect(
      (await api(`/api/messages/${s.data.messageId}`, { method: "PUT", cookie: member.cookie, body: { content: "x" } }))
        .status,
    ).toBe(403);
    expect((await api(`/api/messages/${s.data.messageId}`, { method: "DELETE", cookie: member.cookie })).status).toBe(
      403,
    );
    // 回归：公开频道消息不受私有频道成员资格影响，仍可改删
    const pub = await api("/api/messages/send", {
      method: "POST",
      cookie: member.cookie,
      body: { target: "#general", content: "pub" },
    });
    expect(pub.status).toBe(200);
    expect(
      (
        await api(`/api/messages/${pub.data.messageId}`, {
          method: "PUT",
          cookie: member.cookie,
          body: { content: "pub2" },
        })
      ).status,
    ).toBe(200);
    expect((await api(`/api/messages/${pub.data.messageId}`, { method: "DELETE", cookie: member.cookie })).status).toBe(
      200,
    );
  });
});
