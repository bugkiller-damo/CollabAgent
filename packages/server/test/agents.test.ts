import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, sql, uniqHandle } from "./helpers.js";

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

  it("旧版 /internal/agent 顶层路由已下线（P0.4）", async () => {
    expect((await api("/internal/agent/", { cookie: ck })).status).toBe(404);
    expect((await api("/internal/agent/channel/00000000-0000-0000-0000-000000000000", { cookie: ck })).status).toBe(
      404,
    );
    expect(
      (
        await api("/internal/agent/", {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { name: "x", serverId: "00000000-0000-0000-0000-000000000000" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("/internal/agent/00000000-0000-0000-0000-000000000000", {
          method: "PATCH",
          cookie: ck,
          csrf: cs,
          body: { runtime: "claude" },
        })
      ).status,
    ).toBe(404);
  });

  it("POST /api/agents/:id/duty — owner 可停班/值班", async () => {
    const name = "duty_" + Date.now().toString(36);
    const created = await api("/api/agents", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name, displayName: "Duty" },
    });
    expect(created.status).toBe(200);
    const id = created.data.agent.id as string;
    const off = await api(`/api/agents/${id}/duty`, { method: "POST", cookie: ck, csrf: cs, body: { duty: "off" } });
    expect(off.status).toBe(200);
    expect(off.data.duty).toBe("off");
    expect(off.data.presence).toBe("off_duty");
    expect(off.data.isOnline).toBe(false);
    const listed = await api("/api/agents", { cookie: ck });
    const row = (listed.data.agents as any[]).find((a) => a.id === id);
    expect(row.duty).toBe("off");
    expect(row.presence).toBe("off_duty");
    const on = await api(`/api/agents/${id}/duty`, { method: "POST", cookie: ck, csrf: cs, body: { duty: "on" } });
    expect(on.status).toBe(200);
    expect(on.data.duty).toBe("on");
    expect(["idle", "computer_offline"]).toContain(on.data.presence);
    const bad = await api(`/api/agents/${id}/duty`, { method: "POST", cookie: ck, csrf: cs, body: { duty: "maybe" } });
    expect(bad.status).toBe(400);
  });
});

// P0.4：join/leave 租户收敛——频道名只在 (server_id, lower(name)) 内唯一，
// 裸名解析不得命中其他租户的同名频道（跨租户串频道）。
describe("P0.4: agent join/leave 租户收敛", () => {
  async function mkAgent(cookie: string, csrf: string) {
    const r = await api("/api/agents", {
      method: "POST",
      cookie,
      csrf,
      body: { name: "join_" + uniqHandle(), displayName: "JoinTest" },
    });
    expect(r.status).toBe(200);
    return r.data.agent as { id: string; server_id: string };
  }

  async function mkChannel(cookie: string, csrf: string, body: Record<string, unknown>) {
    const r = await api("/api/channels", { method: "POST", cookie, csrf, body });
    expect(r.status).toBe(200);
    return r.data.channel as { id: string; server_id: string };
  }

  async function agentChannelIds(agentId: string): Promise<string[]> {
    const rows =
      await sql`SELECT channel_id::text AS id FROM channel_members WHERE member_id = ${agentId} AND member_type = 'agent'`;
    return rows.map((r: any) => String(r.id));
  }

  it("同名频道命中 agent 自己的 org；leave 移除成员行", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const agA = await mkAgent(a.cookie, a.csrf);
    const agB = await mkAgent(b.cookie, b.csrf);
    const chName = "zz_join_" + Date.now().toString(36);
    const chA = await mkChannel(a.cookie, a.csrf, { name: chName, type: "public", serverId: agA.server_id });
    const chB = await mkChannel(b.cookie, b.csrf, { name: chName, type: "public", serverId: agB.server_id });
    expect(chA.id).not.toBe(chB.id);

    const j = await api(`/internal/agent/${agB.id}/channels/${chName}/join`, {
      method: "POST",
      cookie: b.cookie,
      csrf: b.csrf,
    });
    expect(j.status).toBe(200);
    expect(await agentChannelIds(agB.id)).toEqual([chB.id]);

    const l = await api(`/internal/agent/${agB.id}/channels/${chName}/leave`, {
      method: "POST",
      cookie: b.cookie,
      csrf: b.csrf,
    });
    expect(l.status).toBe(200);
    expect(await agentChannelIds(agB.id)).toEqual([]);
  });

  it("跨租户频道 join → 404（不泄露存在性）", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const agA = await mkAgent(a.cookie, a.csrf);
    const agB = await mkAgent(b.cookie, b.csrf);
    const chName = "zz_only_" + Date.now().toString(36);
    await mkChannel(a.cookie, a.csrf, { name: chName, type: "public", serverId: agA.server_id });

    const j = await api(`/internal/agent/${agB.id}/channels/${chName}/join`, {
      method: "POST",
      cookie: b.cookie,
      csrf: b.csrf,
    });
    expect(j.status).toBe(404);
  });

  it("默认社区公开频道 join 保持放行（单租户豁免回归）", async () => {
    const c = await registerUser();
    const agC = await mkAgent(c.cookie, c.csrf);
    // 不带 serverId 建频道 → resolveTenant 兜底默认 server（web 建频道的实际形态）
    const chName = "zz_def_" + Date.now().toString(36);
    const ch = await mkChannel(c.cookie, c.csrf, { name: chName, type: "public" });
    const j = await api(`/internal/agent/${agC.id}/channels/${chName}/join`, {
      method: "POST",
      cookie: c.cookie,
      csrf: c.csrf,
    });
    expect(j.status).toBe(200);
    expect(await agentChannelIds(agC.id)).toContain(ch.id);
  });

  it("私有频道 join 仍 403（须邀请）", async () => {
    const c = await registerUser();
    const agC = await mkAgent(c.cookie, c.csrf);
    const chName = "zz_priv_" + Date.now().toString(36);
    await mkChannel(c.cookie, c.csrf, { name: chName, type: "private", serverId: agC.server_id });
    const j = await api(`/internal/agent/${agC.id}/channels/${chName}/join`, {
      method: "POST",
      cookie: c.cookie,
      csrf: c.csrf,
    });
    expect(j.status).toBe(403);
  });
});

// P0.11：PATCH/DELETE /api/agents/:id 所有权校验——org 成员校验挡不住共享 org 内
// 改/删他人 agent 的水平越权，收敛到 requireOwnAgent（与 /internal/agent 侧对齐）。
describe("P0.11: agent 编辑/删除所有权", () => {
  it("同 org 非 owner PATCH/DELETE 他人 agent → 403；owner 正常编辑/删除", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const orgId = (await (await api("/api/orgs", { cookie: owner.cookie })).data.orgs[0]?.id) || "";
    // member 加入 owner 的个人 org：org 校验本会放行，所有权校验必须拦下
    expect(
      (
        await api(`/api/orgs/${orgId}/members`, {
          method: "POST",
          cookie: owner.cookie,
          csrf: owner.csrf,
          body: { handle: member.handle },
        })
      ).status,
    ).toBe(200);
    const created = await api("/api/agents", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: "own_" + uniqHandle(), displayName: "Owned", serverId: orgId },
    });
    expect(created.status).toBe(200);
    const id = created.data.agent.id as string;

    const patch = await api(`/api/agents/${id}`, {
      method: "PATCH",
      cookie: member.cookie,
      csrf: member.csrf,
      body: { displayName: "Hacked" },
    });
    expect(patch.status).toBe(403);
    expect(patch.data.error).toBe("not your agent");
    const del = await api(`/api/agents/${id}`, { method: "DELETE", cookie: member.cookie, csrf: member.csrf });
    expect(del.status).toBe(403);
    expect(del.data.error).toBe("not your agent");

    // 越权未遂后 agent 原样保留
    const listed = await api("/api/agents", { cookie: owner.cookie });
    const row = (listed.data.agents as any[]).find((a) => a.id === id);
    expect(row).toBeTruthy();
    expect(row.display_name).toBe("Owned");

    // owner 正常路径：PATCH 生效 → DELETE 成功 → 再次访问 404
    const okPatch = await api(`/api/agents/${id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { displayName: "Renamed" },
    });
    expect(okPatch.status).toBe(200);
    expect(okPatch.data.agent.display_name).toBe("Renamed");
    const okDel = await api(`/api/agents/${id}`, { method: "DELETE", cookie: owner.cookie, csrf: owner.csrf });
    expect(okDel.status).toBe(200);
    expect(okDel.data.ok).toBe(true);
    const gone = await api(`/api/agents/${id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { displayName: "x" },
    });
    expect(gone.status).toBe(404);
  });

  it("非 org 成员 DELETE 他人 agent → 403（不泄露删除能力）", async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const created = await api("/api/agents", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: "own_" + uniqHandle(), displayName: "Owned" },
    });
    expect(created.status).toBe(200);
    const id = created.data.agent.id as string;
    const del = await api(`/api/agents/${id}`, { method: "DELETE", cookie: outsider.cookie, csrf: outsider.csrf });
    expect(del.status).toBe(403);
    expect(del.data.error).toBe("not your agent");
  });
});
