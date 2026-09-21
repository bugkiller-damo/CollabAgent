import { afterAll, describe, expect, it } from "vitest";
import { connectCommand } from "../src/routes/computers.js";
import { api, cleanupTestData, closeSql, ensureTestComputer, registerUser, sql, uniqHandle } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

async function createOrg(cookie: string, name = "zz_comp_org") {
  const r = await api("/api/orgs", { method: "POST", cookie, body: { name: name + uniqHandle().slice(-6) } });
  expect(r.status).toBe(200);
  return r.data.org as { id: string; name: string };
}

// 接入向导命令生成：前缀由 DAEMON_LAUNCH_CMD 配置（默认 monorepo dev 形态），
// 分发部署改 env 即切 npx/二进制/docker 形态；--server-url/--api-key/--server 恒定由代码追加。
describe("connectCommand", () => {
  it("默认 pnpm dev 形态；launchCmd 可注入覆盖；尾斜杠归一化；--server 仅在有名时追加", () => {
    expect(connectCommand("http://h:3001/", "tok")).toBe(
      "pnpm --filter @collabagent/daemon dev -- --server-url http://h:3001 --api-key tok",
    );
    expect(connectCommand("http://h:3001", "tok", "srv", "npx --yes @collabagent/daemon")).toBe(
      'npx --yes @collabagent/daemon --server-url http://h:3001 --api-key tok --server "srv"',
    );
  });
});

// 2026-09-19 server-scoped computers（docs/2026-09-19/01-server-scoped-computers.md）：
// 行 = (user, server, machine) 三维；scope 必显式（不落 personal）；读=成员、写=属主、
// token=owner；agent 创建须目标 server 已有计算机行并绑定 computer_id。
describe("/api/computers（server-scoped）", () => {
  it("未登录 401", async () => {
    const r = await api("/api/computers/me");
    expect(r.status).toBe(401);
  });

  it("缺 serverId → 400（Q7：不落 personal 兜底）", async () => {
    const u = await registerUser();
    const r = await api("/api/computers/me", { cookie: u.cookie });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/serverId/);
    const list = await api("/api/computers", { cookie: u.cookie });
    expect(list.status).toBe(400);
  });

  it("GET /me 空态 computers:[]；铺行后出现；x-server-id 头与 query 同效", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie);
    const empty = await api(`/api/computers/me?serverId=${org.id}`, { cookie: u.cookie });
    expect(empty.status).toBe(200);
    expect(empty.data.computers).toEqual([]);

    const seeded = await ensureTestComputer(u, org.id, { name: "灵耀14air" });
    const viaQuery = await api(`/api/computers/me?serverId=${org.id}`, { cookie: u.cookie });
    expect(viaQuery.data.computers.length).toBe(1);
    expect(viaQuery.data.computers[0].id).toBe(seeded.id);
    expect(viaQuery.data.computers[0].name).toBe("灵耀14air");
    expect(viaQuery.data.computers[0].mine).toBe(true);

    const viaHeader = await api("/api/computers/me", { cookie: u.cookie, headers: { "x-server-id": org.id } });
    expect(viaHeader.data.computers.length).toBe(1);
  });

  it("GET /api/computers?serverId 成员可读全量（含他人行 + mine/ownerHandle）；非成员 403", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const outsider = await registerUser();
    const org = await createOrg(owner.cookie);
    await api(`/api/orgs/${org.id}/members`, {
      method: "POST",
      cookie: owner.cookie,
      body: { handle: member.handle },
    });

    await ensureTestComputer(owner, org.id, { name: "owner机" });
    // member 的计算机行直插铺底（生产路径是 member 自己的 daemon ready upsert——
    // token 签发是 owner-only，但行可见性语义按成员读全量验证）
    await ensureTestComputer(member, org.id, { name: "member机" });

    const list = await api(`/api/computers?serverId=${org.id}`, { cookie: member.cookie });
    expect(list.status).toBe(200);
    expect(list.data.computers.length).toBe(2);
    const mine = list.data.computers.find((c: any) => c.name === "member机");
    const theirs = list.data.computers.find((c: any) => c.name === "owner机");
    expect(mine.mine).toBe(true);
    expect(theirs.mine).toBe(false);
    expect(theirs.ownerHandle).toBe(owner.handle);

    const denied = await api(`/api/computers?serverId=${org.id}`, { cookie: outsider.cookie });
    expect(denied.status).toBe(403);
  });

  it("PATCH /:id 属主改名；他人 PATCH 403；DELETE /:id 他人 403", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const org = await createOrg(a.cookie);
    await api(`/api/orgs/${org.id}/members`, { method: "POST", cookie: a.cookie, body: { handle: b.handle } });
    const seeded = await ensureTestComputer(a, org.id);

    const patched = await api(`/api/computers/${seeded.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      csrf: a.csrf,
      body: { name: "灵耀14air", description: "办公本" },
    });
    expect(patched.status).toBe(200);
    expect(patched.data.computer.name).toBe("灵耀14air");
    expect(patched.data.computer.description).toBe("办公本");

    const forbidden = await api(`/api/computers/${seeded.id}`, {
      method: "PATCH",
      cookie: b.cookie,
      csrf: b.csrf,
      body: { name: "hijack" },
    });
    expect(forbidden.status).toBe(403);
    const delDenied = await api(`/api/computers/${seeded.id}`, { method: "DELETE", cookie: b.cookie, csrf: b.csrf });
    expect(delDenied.status).toBe(403);

    // 成员可读他人行详情（Q6 可见性），带 mine=false
    const detail = await api(`/api/computers/${seeded.id}`, { cookie: b.cookie });
    expect(detail.status).toBe(200);
    expect(detail.data.computer.mine).toBe(false);
  });

  it("绑定 agent 的机 DELETE 409；解绑（删 agent）后可删", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie);
    const seeded = await ensureTestComputer(u, org.id);
    const created = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "ag_comp_" + Date.now().toString(36), serverId: org.id },
    });
    expect(created.status).toBe(200);
    // 单机自动绑定
    const agentRows = await sql`SELECT computer_id FROM agents WHERE id = ${created.data.agent.id}`;
    expect(String(agentRows[0].computer_id)).toBe(seeded.id);

    const blocked = await api(`/api/computers/${seeded.id}`, { method: "DELETE", cookie: u.cookie, csrf: u.csrf });
    expect(blocked.status).toBe(409);
    expect(blocked.data.agentCount).toBe(1);

    await api(`/api/agents/${created.data.agent.id}`, { method: "DELETE", cookie: u.cookie, csrf: u.csrf });
    const gone = await api(`/api/computers/${seeded.id}`, { method: "DELETE", cookie: u.cookie, csrf: u.csrf });
    expect(gone.status).toBe(200);
  });

  it("POST /me/token：owner 签发（命令带 --server 声明）；member 403；缺 serverId 400", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const org = await createOrg(owner.cookie);
    await api(`/api/orgs/${org.id}/members`, { method: "POST", cookie: owner.cookie, body: { handle: member.handle } });

    const missing = await api("/api/computers/me/token", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: {},
    });
    expect(missing.status).toBe(400);

    const denied = await api("/api/computers/me/token", {
      method: "POST",
      cookie: member.cookie,
      csrf: member.csrf,
      body: { serverId: org.id },
    });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toMatch(/owner/);

    const ok = await api("/api/computers/me/token", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { serverId: org.id },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.token).toMatch(/^sk_machine_/);
    expect(String(ok.data.command)).toContain("--api-key");
    expect(String(ok.data.command)).toContain("--server");
    expect(ok.data.serverId).toBe(org.id);

    // 签发不吊销同 scope 旧钥（多机各持一枚是合法形态）；单钥吊销走 /api/profile/tokens
    const second = await api("/api/computers/me/token", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { serverId: org.id },
    });
    expect(second.status).toBe(200);
    const listed = await api("/api/profile/tokens", { cookie: owner.cookie });
    const active = (listed.data.tokens || []).filter((t: { revoked_at: string | null }) => !t.revoked_at);
    expect(active.length).toBe(2);
  });

  it("agent 绑定语义：无计算机行 400；多机须 computerId；显式绑定成功", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie);

    // 无计算机行 → 400 no_computer_in_server
    const noMachine = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "ag_nomach_" + uniqHandle().slice(-6), serverId: org.id },
    });
    expect(noMachine.status).toBe(400);
    expect(noMachine.data.code).toBe("no_computer_in_server");

    // 两台机器 → 不传 computerId 400（带候选）
    const m1 = await ensureTestComputer(u, org.id, { machineUuid: crypto.randomUUID(), name: "机A" });
    await ensureTestComputer(u, org.id, { machineUuid: crypto.randomUUID(), name: "机B" });
    const multi = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "ag_multi_" + uniqHandle().slice(-6), serverId: org.id },
    });
    expect(multi.status).toBe(400);
    expect(multi.data.code).toBe("computer_required");
    expect(multi.data.candidates.length).toBe(2);

    // 显式 computerId → 绑定成功
    const bound = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "ag_bound_" + uniqHandle().slice(-6), serverId: org.id, computerId: m1.id },
    });
    expect(bound.status).toBe(200);
    const rows = await sql`SELECT computer_id FROM agents WHERE id = ${bound.data.agent.id}`;
    expect(String(rows[0].computer_id)).toBe(m1.id);

    // 别的 server 的 computerId → 400
    const org2 = await createOrg(u.cookie);
    const other = await ensureTestComputer(u, org2.id);
    const wrong = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "ag_wrong_" + uniqHandle().slice(-6), serverId: org.id, computerId: other.id },
    });
    expect(wrong.status).toBe(400);
  });

  it("/api/daemon/status 兼容 connected 字段", async () => {
    const u = await registerUser();
    const r = await api("/api/daemon/status", { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.data.connected).toBe(false);
    expect(r.data).toHaveProperty("runtimes");
  });
});
