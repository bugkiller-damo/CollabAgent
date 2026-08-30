import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("actions: /api/actions/prepare 加固（P0.8）", () => {
  let ck: string;
  let otherCk: string;
  let privName: string;

  beforeAll(async () => {
    const u = await registerUser();
    ck = u.cookie;
    const o = await registerUser();
    otherCk = o.cookie;
    const g = await api("/api/channels/resolve?target=" + encodeURIComponent("#general"), { cookie: ck });
    if (g.status !== 200) await api("/api/channels", { method: "POST", cookie: ck, body: { name: "general" } });
    privName = `actpriv${Date.now().toString(36)}`;
    const p = await api("/api/channels", { method: "POST", cookie: ck, body: { name: privName, type: "private" } });
    if (p.status >= 300) throw new Error("create private channel failed: " + JSON.stringify(p.data));
  });

  it("白名单类型可投递（channel:create）", async () => {
    const r = await api("/api/actions/prepare", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", action: { type: "channel:create", name: "x" } },
    });
    expect(r.status).toBe(200);
    expect(r.data.cardId).toBeTruthy();
  });

  it("白名单外 type 400", async () => {
    const r = await api("/api/actions/prepare", {
      method: "POST",
      cookie: ck,
      body: { target: "#general", action: { type: "rm:-rf" } },
    });
    expect(r.status).toBe(400);
  });

  it("缺 target 400；频道不存在 404（原为 NOT NULL 约束必 500）", async () => {
    const noTarget = await api("/api/actions/prepare", {
      method: "POST",
      cookie: ck,
      body: { action: { type: "channel:create" } },
    });
    expect(noTarget.status).toBe(400);
    const noCh = await api("/api/actions/prepare", {
      method: "POST",
      cookie: ck,
      body: { target: "#no_such_channel_xyz", action: { type: "channel:create" } },
    });
    expect(noCh.status).toBe(404);
  });

  it("非成员向私有频道投卡片 403（原为越权写入）", async () => {
    const r = await api("/api/actions/prepare", {
      method: "POST",
      cookie: otherCk,
      body: { target: "#" + privName, action: { type: "channel:create" } },
    });
    expect(r.status).toBe(403);
  });

  it("成员向私有频道投卡片成功", async () => {
    const r = await api("/api/actions/prepare", {
      method: "POST",
      cookie: ck,
      body: { target: "#" + privName, action: { type: "agent:create", name: "bot" } },
    });
    expect(r.status).toBe(200);
    expect(r.data.cardId).toBeTruthy();
  });
});
