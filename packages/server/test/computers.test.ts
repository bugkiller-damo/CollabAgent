import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("/api/computers", () => {
  it("未登录 401", async () => {
    const r = await api("/api/computers/me");
    expect(r.status).toBe(401);
  });

  it("没有行时 GET /me 404；POST 幂等创建", async () => {
    const u = await registerUser();
    const missing = await api("/api/computers/me", { cookie: u.cookie });
    expect(missing.status).toBe(404);

    const created = await api("/api/computers", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: {} });
    expect(created.status).toBe(200);
    expect(created.data.computer?.name).toBeTruthy();
    expect(created.data.connected).toBe(false);

    const again = await api("/api/computers", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: {} });
    expect(again.status).toBe(200);
    expect(again.data.computer.id).toBe(created.data.computer.id);
  });

  it("PATCH 改名称；别人的 id 403", async () => {
    const a = await registerUser();
    const b = await registerUser();
    await api("/api/computers", { method: "POST", cookie: a.cookie, csrf: a.csrf, body: {} });
    const mine = await api("/api/computers/me", { cookie: a.cookie });
    const patched = await api("/api/computers/me", {
      method: "PATCH",
      cookie: a.cookie,
      csrf: a.csrf,
      body: { name: "灵耀14air", description: "办公本" },
    });
    expect(patched.status).toBe(200);
    expect(patched.data.computer.name).toBe("灵耀14air");
    expect(patched.data.computer.description).toBe("办公本");

    const other = await api(`/api/computers/${mine.data.computer.id}`, { cookie: b.cookie });
    expect(other.status).toBe(403);
  });

  it("还有 agent 时 DELETE 409；清空后可删", async () => {
    const u = await registerUser();
    await api("/api/computers", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: {} });
    const agentName = "ag_comp_" + Date.now().toString(36);
    const created = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: agentName },
    });
    expect(created.status).toBe(200);

    const blocked = await api("/api/computers/me", { method: "DELETE", cookie: u.cookie, csrf: u.csrf });
    expect(blocked.status).toBe(409);

    await api(`/api/agents/${created.data.agent.id}`, { method: "DELETE", cookie: u.cookie, csrf: u.csrf });
    const gone = await api("/api/computers/me", { method: "DELETE", cookie: u.cookie, csrf: u.csrf });
    expect(gone.status).toBe(200);
    expect((await api("/api/computers/me", { cookie: u.cookie })).status).toBe(404);
  });

  it("轮换 token 吊销旧钥并返回命令", async () => {
    const u = await registerUser();
    const first = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: {},
    });
    expect(first.status).toBe(200);
    const oldToken = first.data.token as string;

    const rotated = await api("/api/computers/me/token", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: {} });
    expect(rotated.status).toBe(200);
    expect(rotated.data.token).toMatch(/^sk_machine_/);
    expect(rotated.data.token).not.toBe(oldToken);
    expect(String(rotated.data.command)).toContain("--api-key");
    expect(String(rotated.data.command)).toContain("pnpm --filter @collabagent/daemon");

    const listed = await api("/api/profile/tokens", { cookie: u.cookie });
    const active = (listed.data.tokens || []).filter((t: { revoked_at: string | null }) => !t.revoked_at);
    expect(active.length).toBe(1);
  });

  it("/api/daemon/status 兼容 connected 字段", async () => {
    const u = await registerUser();
    const r = await api("/api/daemon/status", { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.data.connected).toBe(false);
    expect(r.data).toHaveProperty("runtimes");
  });
});
