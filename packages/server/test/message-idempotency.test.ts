import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

// O15：POST /api/messages/send 的 clientNonce 幂等——
// 同频道同 nonce 重放返回首条消息（deduplicated:true），不产生任何重复副作用。
afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("messages: clientNonce 发送幂等", () => {
  let ck: string;
  // 每个用例独立 nonce/内容，避免与历史数据或其他用例互相干扰
  const nonce1 = randomUUID();
  const nonce2 = randomUUID();
  const content1 = `idem-${randomUUID()}`;
  const chan2 = `zzidem${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  beforeAll(async () => {
    const u = await registerUser();
    ck = u.cookie;
    const ch = await api("/api/channels/resolve?target=" + encodeURIComponent("#general"), { cookie: ck });
    if (ch.status !== 200) await api("/api/channels", { method: "POST", cookie: ck, body: { name: "general" } });
    const c2 = await api("/api/channels", { method: "POST", cookie: ck, body: { name: chan2 } });
    expect(c2.status).toBe(200);
  });

  it("同频道 + 同 nonce 连发两次 → 同 messageId/messageSeq，第二次 deduplicated:true，频道内只有一条", async () => {
    const r1 = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: content1, clientNonce: nonce1 },
    });
    expect(r1.status).toBe(200);
    expect(r1.data.state).toBe("sent");
    expect(r1.data.clientNonce).toBe(nonce1); // 有传才回显
    expect(r1.data.deduplicated).toBeUndefined();

    const r2 = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: content1, clientNonce: nonce1 },
    });
    expect(r2.status).toBe(200);
    expect(r2.data.state).toBe("sent");
    expect(r2.data.messageId).toBe(r1.data.messageId);
    expect(r2.data.messageSeq).toBe(r1.data.messageSeq);
    expect(r2.data.clientNonce).toBe(nonce1);
    expect(r2.data.deduplicated).toBe(true);

    // 频道内该内容只有一条消息（无重复消息行）
    const list = await api("/api/messages?channel=" + encodeURIComponent("#general"), { cookie: ck });
    expect(list.status).toBe(200);
    const mine = list.data.messages.filter((m: any) => m.content === content1);
    expect(mine.length).toBe(1);
  });

  it("同 nonce 不同频道互不影响", async () => {
    const r1 = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: `idem-x-${randomUUID()}`, clientNonce: nonce2 },
    });
    const r2 = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: `#${chan2}`, content: `idem-y-${randomUUID()}`, clientNonce: nonce2 },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.data.deduplicated).toBeUndefined(); // 不同频道不算重放
    expect(r2.data.messageId).not.toBe(r1.data.messageId);
  });

  it("不带 nonce 重发 → 两条（向后兼容）", async () => {
    const content = `idem-no-nonce-${randomUUID()}`;
    const r1 = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content },
    });
    const r2 = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.data.clientNonce).toBeUndefined();
    expect(r2.data.messageId).not.toBe(r1.data.messageId);
  });

  it("非法 nonce → 400 invalid clientNonce", async () => {
    // 过短（< 8 字符）
    const short = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "x", clientNonce: "ab-123" },
    });
    expect(short.status).toBe(400);
    expect(short.data.error).toBe("invalid clientNonce");

    // 非法字符（下划线/空格不在允许集内）
    const badChars = await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", content: "x", clientNonce: "bad_nonce_1234" },
    });
    expect(badChars.status).toBe(400);
    expect(badChars.data.error).toBe("invalid clientNonce");
  });
});
