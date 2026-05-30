import { describe, it, expect, afterAll } from "vitest";
import { api, registerUser, cleanupTestData, closeSql } from "./helpers.js";

afterAll(async () => { await cleanupTestData(); await closeSql(); });

describe("direct messages: 三向收发 + 成员隔离", () => {
  it("两个用户互发 DM 命中同一频道，双方可读", async () => {
    const a = await registerUser();
    const b = await registerUser();

    const send1 = await api("/api/messages/send", {
      method: "POST", token: a.token,
      body: { target: `dm:@${b.handle}`, content: "hi from a" },
    });
    expect(send1.status).toBe(200);
    expect(send1.data.channelId).toMatch(/^dm:/);

    const send2 = await api("/api/messages/send", {
      method: "POST", token: b.token,
      body: { target: `dm:@${a.handle}`, content: "reply from b" },
    });
    expect(send2.status).toBe(200);
    // 同一对人 → 同一频道
    expect(send2.data.channelId).toBe(send1.data.channelId);

    const readByA = await api(`/api/messages?channel=${encodeURIComponent("dm:@" + b.handle)}`, { token: a.token });
    expect(readByA.status).toBe(200);
    const contents = readByA.data.messages.map((m: any) => m.content);
    expect(contents).toContain("hi from a");
    expect(contents).toContain("reply from b");
  });

  it("非成员无法读取他人 DM 频道（403）", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const c = await registerUser();

    await api("/api/messages/send", { method: "POST", token: a.token, body: { target: `dm:@${b.handle}`, content: "secret" } });
    const resolved = await api(`/api/channels/resolve?target=${encodeURIComponent("dm:@" + b.handle)}`, { token: a.token });
    expect(resolved.status).toBe(200);
    const channelId: string = resolved.data.channelId;

    const peek = await api(`/api/messages?channel=${encodeURIComponent("dm:" + channelId)}`, { token: c.token });
    expect(peek.status).toBe(403);
  });

  it("DM 频道不出现在常规频道列表", async () => {
    const a = await registerUser();
    const b = await registerUser();
    await api("/api/messages/send", { method: "POST", token: a.token, body: { target: `dm:@${b.handle}`, content: "x" } });
    const chans = await api("/api/channels", { token: a.token });
    expect(chans.status).toBe(200);
    const hasDm = (chans.data.channels || []).some((c: any) => c.type === "dm");
    expect(hasDm).toBe(false);
  });
});
