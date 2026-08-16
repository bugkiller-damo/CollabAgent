import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHostMap, resolveHostServerId } from "../src/lib/tenant.js";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

// ===================== 纯函数单测（host 映射解析） =====================

describe("tenant: parseHostMap", () => {
  it("空/缺失 → 空 Map", () => {
    expect(parseHostMap("").size).toBe(0);
    expect(parseHostMap(undefined).size).toBe(0);
    expect(parseHostMap("  , ").size).toBe(0);
  });
  it("解析单条并小写 host", () => {
    const m = parseHostMap(`ACME.Example.COM=${U1}`);
    expect(m.get("acme.example.com")).toBe(U1);
  });
  it("解析多条（含空格）", () => {
    const m = parseHostMap(`a.example.com=${U1}, b.example.com = ${U2}`);
    expect(m.size).toBe(2);
    expect(m.get("a.example.com")).toBe(U1);
    expect(m.get("b.example.com")).toBe(U2);
  });
  it("跳过非法条目（非 UUID / 空 host / 缺分隔）", () => {
    const m = parseHostMap(`bad.example.com=not-a-uuid, =${U1}, host.example.com=, malformed`);
    expect(m.size).toBe(0);
  });
});

describe("tenant: resolveHostServerId", () => {
  const map = parseHostMap(`a.example.com=${U1}, b.example.com=${U2}`);
  it("全量匹配", () => {
    expect(resolveHostServerId(map, "a.example.com")).toBe(U1);
  });
  it("大小写不敏感", () => {
    expect(resolveHostServerId(map, "A.Example.COM")).toBe(U1);
  });
  it("忽略端口", () => {
    expect(resolveHostServerId(map, "b.example.com:3001")).toBe(U2);
  });
  it("忽略尾随点", () => {
    expect(resolveHostServerId(map, "a.example.com.")).toBe(U1);
  });
  it("未知 host → null", () => {
    expect(resolveHostServerId(map, "evil.example.com")).toBeNull();
    expect(resolveHostServerId(map, "")).toBeNull();
  });
  it("多值 Host 头取第一个", () => {
    expect(resolveHostServerId(map, "a.example.com, b.example.com")).toBe(U1);
  });
});

// ===================== 集成测试：双社区隔离（x-server-id 显式租户） =====================

describe("tenant: 多租户边界（双 server 数据互不串号）", () => {
  let owner: TestUser; // 社区 B 的 owner（成员）
  let outsider: TestUser; // 非社区 B 成员
  let serverB: string;
  let generalB: string; // 社区 B 的 #general 频道 id（与默认社区同名）
  const RUN = "zz_tenant_" + Date.now().toString(36);
  const marker = `zztenantmarker${Date.now().toString(36)}`;

  beforeAll(async () => {
    owner = await registerUser(RUN + "_o");
    outsider = await registerUser(RUN + "_x");
    const s = await sql<
      { id: string }[]
    >`INSERT INTO servers (name, created_by, owner_id, personal) VALUES (${RUN + "_社区B"}, ${owner.userId}, ${owner.userId}, false) RETURNING id`;
    serverB = String(s[0].id);
    await sql`INSERT INTO server_members (server_id, user_id, role) VALUES (${serverB}, ${owner.userId}, 'owner')`;
    const ch = await sql<
      { id: string }[]
    >`INSERT INTO channels (server_id, name, description, created_by) VALUES (${serverB}, 'general', 'tenant-b-general', ${owner.userId}) RETURNING id`;
    generalB = String(ch[0].id);
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("显式租户列频道：只返回社区 B 的频道", async () => {
    const r = await api("/api/channels", { cookie: owner.cookie, headers: { "x-server-id": serverB } });
    expect(r.status).toBe(200);
    const channels = r.data.channels as any[];
    expect(channels.length).toBeGreaterThanOrEqual(1);
    for (const c of channels) expect(String(c.server_id)).toBe(serverB);
    expect(channels.find((c) => c.name === "general" && c.description === "tenant-b-general")).toBeTruthy();
  });

  it("无租户声明（单租户降级）：不出现社区 B 的数据", async () => {
    const r = await api("/api/channels", { cookie: owner.cookie });
    expect(r.status).toBe(200);
    expect((r.data.channels as any[]).some((c) => String(c.server_id) === serverB)).toBe(false);
  });

  it("非成员显式声明社区 B → 403", async () => {
    const r = await api("/api/channels", { cookie: outsider.cookie, headers: { "x-server-id": serverB } });
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/not a member/i);
  });

  it("显式 serverId 查询参数：成员 200 / 非成员 403", async () => {
    const ok = await api(`/api/channels?serverId=${serverB}`, { cookie: owner.cookie });
    expect(ok.status).toBe(200);
    for (const c of ok.data.channels as any[]) expect(String(c.server_id)).toBe(serverB);
    const denied = await api(`/api/channels?serverId=${serverB}`, { cookie: outsider.cookie });
    expect(denied.status).toBe(403);
  });

  it("发消息：同名 #general 在显式租户下落进社区 B", async () => {
    const r = await api("/api/messages/send", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      headers: { "x-server-id": serverB },
      body: { target: "#general", content: marker },
    });
    expect(r.status).toBe(200);
    expect(r.data.state).toBe("sent");

    const rows = await sql`SELECT server_id, channel_id FROM messages WHERE content = ${marker}`;
    expect(rows.length).toBe(1);
    expect(String(rows[0].server_id)).toBe(serverB);
    expect(String(rows[0].channel_id)).toBe(generalB);
  });

  it("读消息：显式租户读社区 B 的 #general，默认降级读默认社区的 #general", async () => {
    const inB = await api("/api/messages?channel=general", {
      cookie: owner.cookie,
      headers: { "x-server-id": serverB },
    });
    expect(inB.status).toBe(200);
    expect((inB.data.messages as any[]).some((m) => m.content === marker)).toBe(true);

    const legacy = await api("/api/messages?channel=general", { cookie: owner.cookie });
    expect(legacy.status).toBe(200);
    expect((legacy.data.messages as any[]).some((m) => m.content === marker)).toBe(false);
  });

  it("搜索：显式租户下只搜到社区 B 的消息", async () => {
    const inB = await api(`/api/messages/search?q=${marker}`, {
      cookie: owner.cookie,
      headers: { "x-server-id": serverB },
    });
    expect(inB.status).toBe(200);
    expect(inB.data.results.length).toBeGreaterThanOrEqual(1);

    const legacy = await api(`/api/messages/search?q=${marker}`, { cookie: owner.cookie });
    expect(legacy.status).toBe(200);
    expect((legacy.data.results as any[]).filter((r) => r.content === marker).length).toBe(0);
  });

  it("非成员用消息 channelId 跨社区读 → 403", async () => {
    // /history 支持裸 channelId；显式租户下频道属于另一社区 → fail-closed 403
    const r = await api(`/api/messages/history?channel=${generalB}`, {
      cookie: outsider.cookie,
      headers: { "x-server-id": serverB },
    });
    expect(r.status).toBe(403);
  });

  it("resolve：同名 #general 在显式租户下解析到社区 B 的频道", async () => {
    const r = await api("/api/channels/resolve?target=general", {
      cookie: owner.cookie,
      headers: { "x-server-id": serverB },
    });
    expect(r.status).toBe(200);
    expect(String(r.data.id)).toBe(generalB);
    expect(String(r.data.server_id)).toBe(serverB);
  });

  it("创建频道：同名频道可在两个社区各自存在（per-server 唯一）", async () => {
    const name = RUN + "_dup";
    const inB = await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      headers: { "x-server-id": serverB },
      body: { name },
    });
    expect(inB.status).toBe(200);
    expect(String(inB.data.channel.server_id)).toBe(serverB);

    // 默认社区（单租户降级）再建同名 → 不冲突
    const legacy = await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name },
    });
    expect(legacy.status).toBe(200);
    expect(String(legacy.data.channel.server_id)).not.toBe(serverB);
  });

  it("server/info：显式租户返回社区 B 信息，humans 仅列社区成员", async () => {
    const r = await api("/api/server/info", {
      cookie: owner.cookie,
      headers: { "x-server-id": serverB },
    });
    expect(r.status).toBe(200);
    expect(String(r.data.serverId)).toBe(serverB);
    expect(r.data.serverName).toContain(RUN);
    const handles = (r.data.humans as any[]).map((h) => h.handle);
    expect(handles).toContain(owner.handle);
    expect(handles).not.toContain(outsider.handle);

    const legacy = await api("/api/server/info", { cookie: owner.cookie });
    expect(legacy.status).toBe(200);
    expect(String(legacy.data.serverId)).not.toBe(serverB);
  });

  it("server/info：非成员显式声明社区 B → 403", async () => {
    const r = await api("/api/server/info", {
      cookie: outsider.cookie,
      headers: { "x-server-id": serverB },
    });
    expect(r.status).toBe(403);
  });
});
