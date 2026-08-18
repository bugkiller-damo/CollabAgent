import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("agent/profile/org: 综合集成测试", () => {
  let ck: string, cs: string;

  beforeAll(async () => {
    const u = await registerUser();
    ck = u.cookie;
    cs = u.csrf;
  });

  it("GET /api/agents — 列取", async () => {
    const r = await api("/api/agents", { cookie: ck });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.agents)).toBe(true);
  });

  it("GET /api/profile/me — 当前用户", async () => {
    const r = await api("/api/profile/me", { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.user).toHaveProperty("handle");
  });

  it("PATCH /api/profile — 更新资料", async () => {
    const r = await api("/api/profile", {
      method: "PATCH",
      cookie: ck,
      csrf: cs,
      body: { displayName: "UPD", description: "d" },
    });
    expect(r.status).toBe(200);
    expect(r.data.user.displayName).toBe("UPD");
  });

  it("GET /api/profile/export — 数据导出", async () => {
    const r = await api("/api/profile/export", { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("profile");
    expect(r.data).toHaveProperty("messages");
  });

  it("GET /api/profile/tokens — 令牌列表", async () => {
    expect((await api("/api/profile/tokens", { cookie: ck })).data.tokens).toBeInstanceOf(Array);
  });

  it("POST /api/profile/machine-token — 生成令牌", async () => {
    const r = await api("/api/profile/machine-token", { method: "POST", cookie: ck, csrf: cs, body: {} });
    expect(r.status).toBe(200);
    expect(r.data.token).toMatch(/^sk_machine_/);
  });

  it("POST /api/profile/change-password — 修改密码", async () => {
    const r = await api("/api/profile/change-password", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { oldPassword: "Test1234", newPassword: "NewPass5678" },
    });
    expect(r.status).toBe(200);
    await api("/api/profile/change-password", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { oldPassword: "NewPass5678", newPassword: "Test1234" },
    });
  });

  it("改密码旧密码错误 401", async () => {
    expect(
      (
        await api("/api/profile/change-password", {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { oldPassword: "wrong", newPassword: "NewPass5678" },
        })
      ).status,
    ).toBe(401);
  });

  it("GET /api/orgs — 组织列表", async () => {
    const r = await api("/api/orgs", { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.orgs[0]).toHaveProperty("name");
    expect(r.data.orgs[0]).toHaveProperty("role");
  });

  it("GET /api/orgs/:id/members — 成员", async () => {
    const orgs = (await api("/api/orgs", { cookie: ck })).data.orgs;
    if (!orgs.length) return;
    const r = await api(`/api/orgs/${orgs[0].id}/members`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.members).toBeInstanceOf(Array);
  });

  it("GET /api/server/info — 服务器信息", async () => {
    const r = await api("/api/server/info", { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("channels");
  });

  it("GET /internal/agent/ — 内部 agent 列表", async () => {
    expect((await api("/internal/agent/", { cookie: ck })).status).toBe(200);
  });
});
