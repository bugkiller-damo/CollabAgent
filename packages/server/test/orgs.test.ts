import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

// 2026-09-18 guild 化（docs/2026-09-18/01-server-guild-refactor-plan.md）：
// POST /orgs 建服、PATCH 改名、leave 退出、invites/:token/accept 已登录接邀请。

let owner: TestUser;
let guest: TestUser;

async function createOrg(cookie: string, name = "zz_test_guild") {
  const r = await api("/api/orgs", { method: "POST", cookie, body: { name } });
  expect(r.status).toBe(200);
  return r.data.org as { id: string; name: string; personal: boolean; role: string };
}

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("guild: POST /api/orgs 建服", () => {
  it("创建成功：owner 成员行 + general 频道 + 频道 owner 同一事务落地", async () => {
    owner = await registerUser();
    const org = await createOrg(owner.cookie);
    expect(org.role).toBe("owner");
    expect(org.personal).toBe(false);
    expect(org.memberCount).toBe(1);

    // general 频道随服创建，创建者是频道 owner
    const ch = await api(`/api/channels?serverId=${org.id}`, { cookie: owner.cookie });
    expect(ch.status).toBe(200);
    const general = ch.data.channels.find((c: any) => c.name === "general");
    expect(general).toBeTruthy();
    const members = await api(`/api/channels/${general.id}/members`, { cookie: owner.cookie });
    const me = members.data.members.find((m: any) => m.member_id === owner.userId);
    expect(me?.role).toBe("owner");

    // /api/orgs 列表含新服
    const orgs = await api("/api/orgs", { cookie: owner.cookie });
    expect(orgs.data.orgs.some((o: any) => o.id === org.id)).toBe(true);
  });

  it("name 校验：空/超长 400", async () => {
    const u = await registerUser();
    const empty = await api("/api/orgs", { method: "POST", cookie: u.cookie, body: { name: "   " } });
    expect(empty.status).toBe(400);
    const long = await api("/api/orgs", { method: "POST", cookie: u.cookie, body: { name: "x".repeat(101) } });
    expect(long.status).toBe(400);
  });
});

describe("guild: PATCH /api/orgs/:id 改名", () => {
  it("owner 可改；非 owner 403；空名 400", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie);
    const ok = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { name: "新名字" },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.org.name).toBe("新名字");

    const other = await registerUser();
    const denied = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: other.cookie,
      body: { name: "hijack" },
    });
    expect(denied.status).toBe(403);
    const bad = await api(`/api/orgs/${org.id}`, { method: "PATCH", cookie: u.cookie, body: { name: " " } });
    expect(bad.status).toBe(400);
  });

  it("personal server 可被 owner 改名（onboarding wizard 路径）", async () => {
    const u = await registerUser();
    const orgs = await api("/api/orgs", { cookie: u.cookie });
    const personal = orgs.data.orgs.find((o: any) => o.personal);
    expect(personal).toBeTruthy();
    const r = await api(`/api/orgs/${personal.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { name: "我的服务器" },
    });
    expect(r.status).toBe(200);
  });
});

describe("guild: POST /api/orgs/:id/leave 退出", () => {
  it("member 可退（退后 server/info 403）；owner 409；personal 409", async () => {
    const u = await registerUser();
    const member = await registerUser();
    const org = await createOrg(u.cookie);
    // owner 直拉 member 进服
    const add = await api(`/api/orgs/${org.id}/members`, {
      method: "POST",
      cookie: u.cookie,
      body: { handle: member.handle },
    });
    expect(add.status).toBe(200);

    const leave = await api(`/api/orgs/${org.id}/leave`, { method: "POST", cookie: member.cookie });
    expect(leave.status).toBe(200);
    const info = await api(`/api/server/info?serverId=${org.id}`, { cookie: member.cookie });
    expect(info.status).toBe(403);

    const ownerLeave = await api(`/api/orgs/${org.id}/leave`, { method: "POST", cookie: u.cookie });
    expect(ownerLeave.status).toBe(409);

    const orgs = await api("/api/orgs", { cookie: u.cookie });
    const personal = orgs.data.orgs.find((o: any) => o.personal);
    const pLeave = await api(`/api/orgs/${personal.id}/leave`, { method: "POST", cookie: u.cookie });
    expect(pLeave.status).toBe(409);
  });
});

describe("guild: POST /api/invites/:token/accept 已登录接邀请", () => {
  it("接受成功入圈；已是成员幂等不烧 uses；无效/吊销拒绝", async () => {
    const u = await registerUser();
    guest = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_invite_org");
    const inv = await api(`/api/orgs/${org.id}/invites`, {
      method: "POST",
      cookie: u.cookie,
      body: { maxUses: 2 },
    });
    expect(inv.status).toBe(200);
    const token = inv.data.token;

    const acc = await api(`/api/invites/${token}/accept`, { method: "POST", cookie: guest.cookie });
    expect(acc.status).toBe(200);
    expect(acc.data.serverId).toBe(org.id);

    // 已是成员再 accept → 幂等放行且不消耗 uses
    const again = await api(`/api/invites/${token}/accept`, { method: "POST", cookie: guest.cookie });
    expect(again.status).toBe(200);
    const row = await sql`SELECT uses FROM invites WHERE token = ${token}`;
    expect(Number(row[0].uses)).toBe(1);

    // 入圈后可读该 server
    const info = await api(`/api/server/info?serverId=${org.id}`, { cookie: guest.cookie });
    expect(info.status).toBe(200);

    // 无效 token
    const bad = await api(`/api/invites/not-a-token/accept`, { method: "POST", cookie: guest.cookie });
    expect(bad.status).toBe(404);

    // 吊销后 410
    const inv2 = await api(`/api/orgs/${org.id}/invites`, { method: "POST", cookie: u.cookie, body: {} });
    await api(`/api/orgs/${org.id}/invites/${inv2.data.token}`, { method: "DELETE", cookie: u.cookie });
    const revoked = await api(`/api/invites/${inv2.data.token}/accept`, { method: "POST", cookie: guest.cookie });
    expect(revoked.status).toBe(410);
  });

  it("限额耗尽 410", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_invite_cap");
    const inv = await api(`/api/orgs/${org.id}/invites`, {
      method: "POST",
      cookie: u.cookie,
      body: { maxUses: 1 },
    });
    const a = await registerUser();
    const b = await registerUser();
    const first = await api(`/api/invites/${inv.data.token}/accept`, { method: "POST", cookie: a.cookie });
    expect(first.status).toBe(200);
    const second = await api(`/api/invites/${inv.data.token}/accept`, { method: "POST", cookie: b.cookie });
    expect(second.status).toBe(410);
  });
});
