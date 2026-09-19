import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  api,
  cleanupTestData,
  closeSql,
  ensureTestComputer,
  makeOrgOwner,
  registerUser,
  sql,
  type TestUser,
  uniqHandle,
} from "./helpers.js";

// 2026-09-18 guild 化（docs/2026-09-18/01-server-guild-refactor-plan.md）：
// POST /orgs 建服、PATCH 改名、leave 退出、invites/:token/accept 已登录接邀请。
// 同日权限模型（docs/2026-09-18/02-server-permission-model.md）：
// servers.is_public 广场标记（PATCH isPublic 走实例管理员门禁）、personal 退化为
// 纯来源标签（可退/可删/可转）、公共 server 自助 join、discover 发现面、owner 移出 agent。
// 2026-09-19：member 可退任意 server 含广场（原 §9.3 拒退废除——发现面使退出不再失联）。

let owner: TestUser;
let guest: TestUser;

async function createOrg(cookie: string, name = "zz_test_guild") {
  const r = await api("/api/orgs", { method: "POST", cookie, body: { name } });
  expect(r.status).toBe(200);
  return r.data.org as { id: string; name: string; role: string; memberCount: number };
}

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("guild: POST /api/orgs 建服", () => {
  it("创建成功：owner 成员行 + 私有 onboarding-owner 频道 + 频道 owner 同一事务落地", async () => {
    owner = await registerUser();
    const org = await createOrg(owner.cookie);
    expect(org.role).toBe("owner");
    expect(org.memberCount).toBe(1);

    // onboarding-owner 私有频道随服创建，创建者是频道 owner
    const ch = await api(`/api/channels?serverId=${org.id}`, { cookie: owner.cookie });
    expect(ch.status).toBe(200);
    const onboarding = ch.data.channels.find((c: any) => c.name === "onboarding-owner");
    expect(onboarding).toBeTruthy();
    expect(onboarding.type).toBe("private");
    const members = await api(`/api/channels/${onboarding.id}/members`, { cookie: owner.cookie });
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

  it("新用户不再懒建个人空间：GET /orgs 仅见广场 membership", async () => {
    const u = await registerUser();
    const orgs = await api("/api/orgs", { cookie: u.cookie });
    expect(orgs.status).toBe(200);
    // personal 兜底取消——注册自动入圈广场是唯一初始 membership
    expect(orgs.data.orgs.length).toBe(1);
    expect(orgs.data.orgs[0].is_public).toBe(true);
    // 自建 server 改名同口径（owner 权限，与 POST /orgs 建服语义一致）
    const org = await createOrg(u.cookie, "zz_test_rename2");
    const r = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { name: "我的服务器" },
    });
    expect(r.status).toBe(200);
    expect(r.data.org.name).toBe("我的服务器");
  });
});

describe("guild: POST /api/orgs/:id/leave 退出", () => {
  // member 可退任意 server（§4 表：含 is_public 广场——退出后回 discover
  // 发现面可再加入，2026-09-19 放开原 §9.3 拒退）。owner 拒退规则不变。
  it("member 可退（自建与公共 server）；owner 409", async () => {
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

    // 第二个自建 server 同口径：member 可退、owner 拒退——personal 特例取消后
    // 所有自建 server 行为一致
    const org2 = await createOrg(u.cookie, "zz_test_leave2");
    const add2 = await api(`/api/orgs/${org2.id}/members`, {
      method: "POST",
      cookie: u.cookie,
      body: { handle: member.handle },
    });
    expect(add2.status).toBe(200);
    const leave2 = await api(`/api/orgs/${org2.id}/leave`, { method: "POST", cookie: member.cookie });
    expect(leave2.status).toBe(200);
    const ownerLeave2 = await api(`/api/orgs/${org2.id}/leave`, { method: "POST", cookie: u.cookie });
    expect(ownerLeave2.status).toBe(409); // owner 拒退同口径

    // member 退公共 server → 200：注册用户自动入圈广场，天然是 member；
    // 退出后成员行消失、卡片回 discover 发现面、可自助再加入（闭环）
    const w = await registerUser();
    const wOrgs = await api("/api/orgs", { cookie: w.cookie });
    const pub = wOrgs.data.orgs.find((o: any) => o.is_public);
    expect(pub).toBeTruthy();
    expect(pub.isDefault).toBe(true); // 广场 = 默认社区（is_public 判定）
    const wLeave = await api(`/api/orgs/${pub.id}/leave`, { method: "POST", cookie: w.cookie });
    expect(wLeave.status).toBe(200);
    const gone = await sql`SELECT 1 FROM server_members WHERE server_id = ${pub.id} AND user_id::text = ${w.userId}`;
    expect(gone.length).toBe(0);
    const d = await api("/api/orgs/discover", { cookie: w.cookie });
    expect((d.data.servers || []).some((s: any) => s.id === pub.id)).toBe(true);
    const rejoin = await api(`/api/orgs/${pub.id}/join`, { method: "POST", cookie: w.cookie });
    expect(rejoin.status).toBe(200);
    const back = await sql`SELECT role FROM server_members WHERE server_id = ${pub.id} AND user_id::text = ${w.userId}`;
    expect(back[0]?.role).toBe("member");
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

describe("guild: DELETE /api/orgs/:id 删除 server（B5）", () => {
  it("owner 删除成功：频道/消息/成员/邀请级联清除，server/info 403", async () => {
    const u = await registerUser();
    const member = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_delete");
    // member 入圈 + 邀请链接 + 第二个频道 + 一条消息
    const add = await api(`/api/orgs/${org.id}/members`, {
      method: "POST",
      cookie: u.cookie,
      body: { handle: member.handle },
    });
    expect(add.status).toBe(200);
    const inv = await api(`/api/orgs/${org.id}/invites`, { method: "POST", cookie: u.cookie, body: {} });
    expect(inv.status).toBe(200);
    const ch2 = await api("/api/channels", {
      method: "POST",
      cookie: u.cookie,
      headers: { "x-server-id": org.id },
      body: { name: "zz_test_del_ch", type: "public" },
    });
    expect(ch2.status).toBe(200);
    const sent = await api("/api/messages/send", {
      method: "POST",
      cookie: u.cookie,
      headers: { "x-server-id": org.id },
      body: { target: "#onboarding-owner", content: "before delete" },
    });
    expect(sent.status).toBe(200);

    const del = await api(`/api/orgs/${org.id}`, { method: "DELETE", cookie: u.cookie });
    expect(del.status).toBe(200);

    // 列表不再出现；邀请 token 随邀请行删除失效
    const orgs = await api("/api/orgs", { cookie: u.cookie });
    expect(orgs.data.orgs.some((o: any) => o.id === org.id)).toBe(false);
    const invCheck = await api(`/api/invites/${inv.data.token}`, { cookie: u.cookie });
    expect(invCheck.status).toBe(404);
    // member 侧的 server/info 访问圈定失效（成员行已删）
    const info = await api(`/api/server/info?serverId=${org.id}`, { cookie: member.cookie });
    expect(info.status).toBe(403);
    // DB 级联清空
    const rows = await sql`
      SELECT (SELECT count(*) FROM channels WHERE server_id = ${org.id}) AS channels,
             (SELECT count(*) FROM messages WHERE server_id = ${org.id}) AS messages,
             (SELECT count(*) FROM server_members WHERE server_id = ${org.id}) AS members,
             (SELECT count(*) FROM invites WHERE server_id = ${org.id}) AS invites,
             (SELECT count(*) FROM servers WHERE id = ${org.id}) AS servers`;
    for (const k of ["channels", "messages", "members", "invites", "servers"] as const) {
      expect(Number(rows[0][k]), k).toBe(0);
    }
  });

  // 2026-09-19 服务器资料页：删服级联含 agent——channels→dispatches 先清，
  // agent_credentials/agent_logins 显式删，agents 本体随服消失
  it("含 agent 的 server 级联删除：agent 与凭证行一并消失", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_del_agents");
    await ensureTestComputer(u, org.id);
    const a = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      body: { name: "zz_agent_del", serverId: org.id },
    });
    expect(a.status).toBe(200);
    const agentId = a.data.agent.id as string;
    // 发一个频道消息让级联路径真实走通（messages → channels → agents）
    const sent = await api("/api/messages/send", {
      method: "POST",
      cookie: u.cookie,
      headers: { "x-server-id": org.id },
      body: { target: "#onboarding-owner", content: "before-delete" },
    });
    expect(sent.status).toBe(200);
    const del = await api(`/api/orgs/${org.id}`, { method: "DELETE", cookie: u.cookie });
    expect(del.status).toBe(200);
    const ag = await sql`SELECT 1 FROM agents WHERE id = ${agentId}`;
    expect(ag.length).toBe(0);
    const creds = await sql`SELECT 1 FROM agent_credentials WHERE agent_id = ${agentId}`;
    expect(creds.length).toBe(0);
    const msgs = await sql`SELECT 1 FROM messages WHERE server_id = ${org.id}`;
    expect(msgs.length).toBe(0);
    const chans = await sql`SELECT 1 FROM channels WHERE server_id = ${org.id}`;
    expect(chans.length).toBe(0);
  });

  // 2026-09-18 权限模型：自建 server 可删（生命周期统一），默认社区拒删改由
  // getDefaultServerId 的 is_public 优先语义承载——公共 server 恒拒删。
  it("非 owner 403；自建 server 可删（同口径级联）；公共 server（广场）409", async () => {
    const u = await registerUser();
    const other = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_del_perm");
    const denied = await api(`/api/orgs/${org.id}`, { method: "DELETE", cookie: other.cookie });
    expect(denied.status).toBe(403);

    // 自建 server 放行：owner 可删——personal 特例取消后所有自建 server 同口径
    const org2 = await createOrg(u.cookie, "zz_test_del_perm2");
    const pDel = await api(`/api/orgs/${org2.id}`, { method: "DELETE", cookie: u.cookie });
    expect(pDel.status).toBe(200);
    const gone = await sql`SELECT 1 FROM servers WHERE id = ${org2.id}`;
    expect(gone.length).toBe(0);

    // 广场（is_public）拒删——getDefaultServerId 现按 is_public 解析，owner 也不能删
    const defId = await makeOrgOwner(u);
    const orgs2 = await api("/api/orgs", { cookie: u.cookie });
    const defOrg = orgs2.data.orgs.find((o: any) => o.id === defId);
    expect(defOrg?.isDefault).toBe(true);
    expect(defOrg?.is_public).toBe(true); // 029 回填的广场标记随列表透出
    const dDel = await api(`/api/orgs/${defId}`, { method: "DELETE", cookie: u.cookie });
    expect(dDel.status).toBe(409);
  });

  it("server 删除后无兜底补建：唯一 owned server 删除后 GET /orgs 为空", async () => {
    // 直插用户（绕过注册自动入圈）——保证被删 server 是其唯一 membership
    const handle = "zz_test_reh_" + uniqHandle().slice(-8);
    const hash = (await import("bcryptjs")).default.hashSync("Test1234", 10);
    await sql`INSERT INTO users (handle, display_name, email, password_hash)
              VALUES (${handle}, ${handle}, ${handle + "@test.local"}, ${hash})`;
    const login = await api("/api/auth/login", { method: "POST", body: { login: handle, password: "Test1234" } });
    expect(login.status).toBe(200);
    const cookie = login.cookieHeader;
    // personal 懒建已取消——直插用户初始无 membership
    const orgs0 = await api("/api/orgs", { cookie });
    expect(orgs0.data.orgs.length).toBe(0);

    const uRows = await sql`SELECT id FROM users WHERE handle = ${handle}`;
    const uid = String(uRows[0].id);
    // 显式建服（无兜底——想要 server 只能自己建或被邀请）
    const mk = await api("/api/orgs", { method: "POST", cookie, body: { name: "zz_reh_home" } });
    expect(mk.status).toBe(200);
    const home = mk.data.org as { id: string };
    const tokHash = "zz_tok_" + home.id;
    await sql`INSERT INTO computers (user_id, server_id, name, machine_uuid)
              VALUES (${uid}, ${home.id}, 'zz-rehome-pc', ${"zz-mu-" + home.id})`;
    await sql`INSERT INTO machine_tokens (user_id, server_id, token_hash, token_prefix, scope)
              VALUES (${uid}, ${home.id}, ${tokHash}, 'sk_machine_', '{}'::jsonb)`;

    const del = await api(`/api/orgs/${home.id}`, { method: "DELETE", cookie });
    expect(del.status).toBe(200);

    // server 删除即设施级联——computer 行与 scoped token 不迁移、不残留
    const rows = await sql`
      SELECT (SELECT count(*) FROM computers WHERE server_id = ${home.id})::text AS comps,
             (SELECT count(*) FROM machine_tokens WHERE server_id = ${home.id})::text AS toks`;
    expect(rows[0].comps).toBe("0");
    expect(rows[0].toks).toBe("0");

    // 取消兜底的核心断言：删除后不再有任何懒建空间——membership 归零
    const orgs2 = await api("/api/orgs", { cookie });
    expect(orgs2.data.orgs.length).toBe(0);
  });

  it("computers/machine_tokens 随服级联删除（server 维度设施不迁移）", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_del_cascade");
    const other = await createOrg(u.cookie, "zz_test_keep_cascade");
    // 待删 server 与保留 server 各挂一台计算机 + 一枚令牌——验证级联只清目标 server
    const tokHash = "zz_tok_" + org.id;
    const tokHashP = "zz_tok_" + other.id;
    await sql`INSERT INTO computers (user_id, server_id, name, machine_uuid) VALUES
              (${u.userId}, ${org.id}, 'zz-org-pc', ${"zz-mu-" + org.id}),
              (${u.userId}, ${other.id}, 'zz-keep-pc', ${"zz-mu-" + other.id})`;
    await sql`INSERT INTO machine_tokens (user_id, server_id, token_hash, token_prefix, scope) VALUES
              (${u.userId}, ${org.id}, ${tokHash}, 'sk_machine_', '{}'::jsonb),
              (${u.userId}, ${other.id}, ${tokHashP}, 'sk_machine_', '{}'::jsonb)`;
    const del = await api(`/api/orgs/${org.id}`, { method: "DELETE", cookie: u.cookie });
    expect(del.status).toBe(200);
    const orgFacilities = await sql`
      SELECT (SELECT count(*) FROM computers WHERE server_id = ${org.id})::text AS comps,
             (SELECT count(*) FROM machine_tokens WHERE server_id = ${org.id})::text AS toks`;
    expect(orgFacilities[0].comps).toBe("0");
    expect(orgFacilities[0].toks).toBe("0");
    // 另一个 server 的设施原样保留
    const homeFacilities = await sql`
      SELECT (SELECT count(*) FROM computers WHERE server_id = ${other.id})::text AS comps,
             (SELECT count(*) FROM machine_tokens WHERE server_id = ${other.id})::text AS toks`;
    expect(homeFacilities[0].comps).toBe("1");
    expect(homeFacilities[0].toks).toBe("1");
  });
});

describe("guild: POST /api/orgs/:id/transfer 转让 owner（B6）", () => {
  it("owner → member 转让成功：owner_id 换指 + 双方 role 互换，权限随角色翻转", async () => {
    const u = await registerUser();
    const m = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_transfer");
    await api(`/api/orgs/${org.id}/members`, { method: "POST", cookie: u.cookie, body: { handle: m.handle } });

    const tr = await api(`/api/orgs/${org.id}/transfer`, {
      method: "POST",
      cookie: u.cookie,
      body: { userId: m.userId },
    });
    expect(tr.status).toBe(200);

    const db = await sql`SELECT owner_id FROM servers WHERE id = ${org.id}`;
    expect(String(db[0].owner_id)).toBe(m.userId);
    const orgsU = await api("/api/orgs", { cookie: u.cookie });
    const orgsM = await api("/api/orgs", { cookie: m.cookie });
    expect(orgsU.data.orgs.find((o: any) => o.id === org.id)?.role).toBe("member");
    expect(orgsM.data.orgs.find((o: any) => o.id === org.id)?.role).toBe("owner");

    // 新 owner 可改名（owner 限定操作），旧 owner 已无权
    const ren = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: m.cookie,
      body: { name: "新主命名" },
    });
    expect(ren.status).toBe(200);
    const denied = await api(`/api/orgs/${org.id}`, { method: "PATCH", cookie: u.cookie, body: { name: "nope" } });
    expect(denied.status).toBe(403);
  });

  // 2026-09-18 权限模型 + 2026-09-19 personal 特例取消：所有自建 server 同口径可转。
  it("目标非成员/非 UUID/本人 → 400；非 owner → 403；第二个自建 server 可转", async () => {
    const u = await registerUser();
    const outsider = await registerUser();
    const member = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_transfer2");
    await api(`/api/orgs/${org.id}/members`, { method: "POST", cookie: u.cookie, body: { handle: member.handle } });

    const nm = await api(`/api/orgs/${org.id}/transfer`, {
      method: "POST",
      cookie: u.cookie,
      body: { userId: outsider.userId },
    });
    expect(nm.status).toBe(400);
    const bad = await api(`/api/orgs/${org.id}/transfer`, {
      method: "POST",
      cookie: u.cookie,
      body: { userId: "not-a-uuid" },
    });
    expect(bad.status).toBe(400);
    const self = await api(`/api/orgs/${org.id}/transfer`, {
      method: "POST",
      cookie: u.cookie,
      body: { userId: u.userId },
    });
    expect(self.status).toBe(400);
    const denied = await api(`/api/orgs/${org.id}/transfer`, {
      method: "POST",
      cookie: member.cookie,
      body: { userId: u.userId },
    });
    expect(denied.status).toBe(403);

    // 第二个自建 server 可转：owner_id 换指 + role 互换走同口径
    const org2 = await createOrg(u.cookie, "zz_test_transfer2b");
    await api(`/api/orgs/${org2.id}/members`, {
      method: "POST",
      cookie: u.cookie,
      body: { handle: member.handle },
    });
    const pTr = await api(`/api/orgs/${org2.id}/transfer`, {
      method: "POST",
      cookie: u.cookie,
      body: { userId: member.userId },
    });
    expect(pTr.status).toBe(200);
    const db = await sql`SELECT owner_id FROM servers WHERE id = ${org2.id}`;
    expect(String(db[0].owner_id)).toBe(member.userId);
  });

  it("转给 admin：旧 owner 降为 admin（role 互换语义）", async () => {
    const u = await registerUser();
    const m = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_transfer3");
    await api(`/api/orgs/${org.id}/members`, { method: "POST", cookie: u.cookie, body: { handle: m.handle } });
    const promote = await api(`/api/orgs/${org.id}/members/${m.userId}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { role: "admin" },
    });
    expect(promote.status).toBe(200);
    const tr = await api(`/api/orgs/${org.id}/transfer`, {
      method: "POST",
      cookie: u.cookie,
      body: { userId: m.userId },
    });
    expect(tr.status).toBe(200);
    const orgsU = await api("/api/orgs", { cookie: u.cookie });
    expect(orgsU.data.orgs.find((o: any) => o.id === org.id)?.role).toBe("admin");
  });
});

// ============================================================================
// 2026-09-18 权限模型（docs/2026-09-18/02-server-permission-model.md）
// ============================================================================

// ============================================================================
// 自建 server 的私有频道 onboarding-owner（POST /orgs 建服事务内同建）：
// type='private' → 仅 channel_members 可见，之后进服的 member 看不到。
// 2026-09-19 personal 特例取消后所有自建 server 同口径。
// ============================================================================

describe("自建 server: onboarding-owner 私有频道", () => {
  it("自建 server 自动带私有频道 onboarding-owner，owner 是频道 owner", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie);

    const info = await api(`/api/server/info?serverId=${org.id}`, { cookie: u.cookie });
    expect(info.status).toBe(200);
    const ch = info.data.channels.find((c: any) => c.name === "onboarding-owner");
    expect(ch).toBeTruthy();
    expect(ch.type).toBe("private");
    // /api/server/info 的 cm.role 直列透出频道成员角色——owner 是频道 owner
    expect(ch.role).toBe("owner");
    const members = await api(`/api/channels/${ch.id}/members`, { cookie: u.cookie });
    expect(members.status).toBe(200);
    const me = members.data.members.find((m: any) => m.member_id === u.userId);
    expect(me?.role).toBe("owner");
  });

  it("拉进 server 的其他成员看不到私有 onboarding-owner", async () => {
    const u = await registerUser();
    const m = await registerUser();
    const org = await createOrg(u.cookie);
    const add = await api(`/api/orgs/${org.id}/members`, {
      method: "POST",
      cookie: u.cookie,
      body: { handle: m.handle },
    });
    expect(add.status).toBe(200);

    // member 是 server 成员（server/info 放行）但非频道成员 → 私有频道不可见
    const info = await api(`/api/server/info?serverId=${org.id}`, { cookie: m.cookie });
    expect(info.status).toBe(200);
    expect(info.data.channels.some((c: any) => c.name === "onboarding-owner")).toBe(false);
    // owner 侧仍可见（对照）
    const ownerInfo = await api(`/api/server/info?serverId=${org.id}`, { cookie: u.cookie });
    expect(ownerInfo.data.channels.some((c: any) => c.name === "onboarding-owner")).toBe(true);
  });

  it("幂等：重复 GET /api/orgs 不产生第二个同名频道", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie);
    await api("/api/orgs", { cookie: u.cookie });
    await api("/api/orgs", { cookie: u.cookie });
    const rows =
      await sql`SELECT count(*)::int AS c FROM channels WHERE server_id = ${org.id} AND lower(name) = lower('onboarding-owner')`;
    expect(rows[0].c).toBe(1);
    // 频道 owner 成员行同样幂等（channel_members PK 兜底）
    const cm =
      await sql`SELECT count(*)::int AS c FROM channel_members WHERE member_id = ${u.userId} AND member_type = 'human' AND channel_id IN (SELECT id FROM channels WHERE server_id = ${org.id})`;
    expect(cm[0].c).toBe(1);
  });
});

describe("permission model: PATCH /api/orgs/:id isPublic 可见性翻转", () => {
  it("非实例管理员翻 isPublic → 403；实例管理员放行；仅改名仍走 owner 口径", async () => {
    const u = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_vis");
    // u 是 org owner 但不是实例管理员 → 翻可见性拒
    const denied = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { isPublic: true },
    });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toBe("only instance admin can change visibility");

    // isPublic 非布尔 → 400（先于门禁的入参校验在门禁后也一样是 400/403 之一，
    // 但即便实例管理员身份，非布尔也必须 400）
    const admin = await makeOrgOwner(u);
    expect(admin).toBeTruthy();
    const badType = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { isPublic: "yes" },
    });
    expect(badType.status).toBe(400);

    // 实例管理员翻转成功（u 现为默认社区 owner = 实例管理员）
    const flip = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { isPublic: true },
    });
    expect(flip.status).toBe(200);
    expect(flip.data.org.is_public).toBe(true);

    // is_public 翻转可改变默认社区归属——本用例翻转的是非默认 server，
    // getDefaultServerId 缓存清理语义由路由内 clearDefaultServerCache 承载；
    // 顺带验证：最早 is_public server 仍是广场（created_at 更早）
    const orgs = await api("/api/orgs", { cookie: u.cookie });
    const def = orgs.data.orgs.find((o: any) => o.isDefault);
    expect(def.id).toBe(admin);
    expect(def.is_public).toBe(true);

    // name + isPublic 同传也走实例管理员口径
    const both = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { name: "广场二号", isPublic: false },
    });
    expect(both.status).toBe(200);
    expect(both.data.org.name).toBe("广场二号");
    expect(both.data.org.is_public).toBe(false);

    // 仅改名仍是 owner 口径（非实例管理员的另一 owner 不可改——保持原语义）
    const other = await registerUser();
    const ren = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: other.cookie,
      body: { name: "hijack" },
    });
    expect(ren.status).toBe(403);
  });
});

describe("permission model: POST /api/orgs/:id/join 自助加入", () => {
  it("private → 403 invite required；public → 200；重复 join 幂等 alreadyMember", async () => {
    const u = await registerUser();
    const joiner = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_join");

    // private server：joiner 无邀请 → 403
    const denied = await api(`/api/orgs/${org.id}/join`, { method: "POST", cookie: joiner.cookie });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toBe("invite required");

    // 实例管理员翻 isPublic → 自助加入放行
    await makeOrgOwner(u);
    const flip = await api(`/api/orgs/${org.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { isPublic: true },
    });
    expect(flip.status).toBe(200);

    const join = await api(`/api/orgs/${org.id}/join`, { method: "POST", cookie: joiner.cookie });
    expect(join.status).toBe(200);
    const row =
      await sql`SELECT role FROM server_members WHERE server_id = ${org.id} AND user_id::text = ${joiner.userId}`;
    expect(row[0]?.role).toBe("member");

    // 幂等：已是成员
    const again = await api(`/api/orgs/${org.id}/join`, { method: "POST", cookie: joiner.cookie });
    expect(again.status).toBe(200);
    expect(again.data.alreadyMember).toBe(true);

    // 公共 server member 也可退（§4 表口径；退出后可再 join）
    const leave = await api(`/api/orgs/${org.id}/leave`, { method: "POST", cookie: joiner.cookie });
    expect(leave.status).toBe(200);
    const rejoin = await api(`/api/orgs/${org.id}/join`, { method: "POST", cookie: joiner.cookie });
    expect(rejoin.status).toBe(200);
  });

  it("无效/不存在 serverId → 400/404", async () => {
    const u = await registerUser();
    const bad = await api(`/api/orgs/not-a-uuid/join`, { method: "POST", cookie: u.cookie });
    expect(bad.status).toBe(400);
    const missing = await api(`/api/orgs/${randomUUID()}/join`, { method: "POST", cookie: u.cookie });
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/orgs/discover 公共 server 发现面", () => {
  it("未加入的 public server 可见可加入；加入后从发现面消失；private 不出现", async () => {
    const u = await registerUser();
    const joiner = await registerUser();
    const pub = await createOrg(u.cookie, "zz_test_discover_pub");
    const priv = await createOrg(u.cookie, "zz_test_discover_priv");

    // 私有 server 不在发现面（joiner 的自建私有空间同理——仅 is_public 进发现面）
    let d = await api("/api/orgs/discover", { cookie: joiner.cookie });
    expect(d.status).toBe(200);
    expect((d.data.servers || []).some((s: any) => s.id === priv.id)).toBe(false);
    // u 已加入 pub：对 u 不显示（只回未加入的）
    const du = await api("/api/orgs/discover", { cookie: u.cookie });
    expect((du.data.servers || []).some((s: any) => s.id === pub.id)).toBe(false);

    // 翻 public → joiner 发现面出现该卡片
    await makeOrgOwner(u);
    const flip = await api(`/api/orgs/${pub.id}`, {
      method: "PATCH",
      cookie: u.cookie,
      body: { isPublic: true },
    });
    expect(flip.status).toBe(200);

    d = await api("/api/orgs/discover", { cookie: joiner.cookie });
    const card = (d.data.servers || []).find((s: any) => s.id === pub.id);
    expect(card).toBeTruthy();
    expect(card.is_public).toBe(true);
    expect(typeof card.memberCount).toBe("number");

    // 加入后从发现面消失，且出现在 GET /orgs
    const join = await api(`/api/orgs/${pub.id}/join`, { method: "POST", cookie: joiner.cookie });
    expect(join.status).toBe(200);
    d = await api("/api/orgs/discover", { cookie: joiner.cookie });
    expect((d.data.servers || []).some((s: any) => s.id === pub.id)).toBe(false);
    const orgs = await api("/api/orgs", { cookie: joiner.cookie });
    expect((orgs.data.orgs || []).some((o: any) => o.id === pub.id)).toBe(true);
  });
});

describe("permission model: DELETE /api/orgs/:id/agents/:agentId 移出 agent", () => {
  it("owner 踢出他人 agent：落属主最早 owned server（绑定唯一计算机）+ 频道成员行清除 + agent 本体保留", async () => {
    const u = await registerUser();
    const agentOwner = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_kick");

    // agentOwner 的 agent 先落自己 owned server，再 SQL 挂进 u 的 org（生产路径是
    // 转让/历史遗留——POST /agents 已收敛 owner 限定，普通成员无法再放置）
    const comp = await ensureTestComputer(agentOwner);
    const ag = await api("/api/agents", {
      method: "POST",
      cookie: agentOwner.cookie,
      body: { name: "zzkick" + uniqHandle().slice(-6), serverId: comp.serverId },
    });
    expect(ag.status).toBe(200);
    const agentId = ag.data.agent.id as string;
    await sql`UPDATE agents SET server_id = ${org.id} WHERE id = ${agentId}`;

    // 频道 + agent 入圈（channel_members 直插，邀请逻辑归 channels 套件）
    const ch = await api("/api/channels", {
      method: "POST",
      cookie: u.cookie,
      headers: { "x-server-id": org.id },
      body: { name: "zz_kick_ch" },
    });
    expect(ch.status).toBe(200);
    await sql`INSERT INTO channel_members (channel_id, member_id, member_type, role)
              VALUES (${ch.data.channel.id}, ${agentId}, 'agent', 'member')`;

    const kick = await api(`/api/orgs/${org.id}/agents/${agentId}`, { method: "DELETE", cookie: u.cookie });
    expect(kick.status).toBe(200);

    // agent 本体保留，落回 agentOwner 最早 owned server（不是请求者的 org），
    // 该 server 只有一台计算机 → 自动绑定
    const rows = await sql`SELECT server_id, computer_id FROM agents WHERE id = ${agentId}`;
    expect(rows.length).toBe(1);
    expect(String(rows[0].server_id)).toBe(comp.serverId);
    expect(String(rows[0].computer_id)).toBe(comp.id);

    // 本 server 内的频道成员行清空
    const cm = await sql`
      SELECT 1 FROM channel_members
       WHERE member_id = ${agentId} AND member_type = 'agent'
         AND channel_id IN (SELECT id FROM channels WHERE server_id = ${org.id})`;
    expect(cm.length).toBe(0);
  });

  it("非 owner → 403；agent 不存在/不在该 server → 404；非 UUID → 400", async () => {
    const u = await registerUser();
    const member = await registerUser();
    const other = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_kick2");
    await api(`/api/orgs/${org.id}/members`, { method: "POST", cookie: u.cookie, body: { handle: member.handle } });

    const otherComp = await ensureTestComputer(other);
    const ag = await api("/api/agents", {
      method: "POST",
      cookie: other.cookie,
      body: { name: "zzkick2" + uniqHandle().slice(-6), serverId: otherComp.serverId },
    });
    await sql`UPDATE agents SET server_id = ${org.id} WHERE id = ${ag.data.agent.id}`;

    // member 无权踢出
    const denied = await api(`/api/orgs/${org.id}/agents/${ag.data.agent.id}`, {
      method: "DELETE",
      cookie: member.cookie,
    });
    expect(denied.status).toBe(403);

    // agent 不在本 server（在 other 自己的 owned server）→ 404
    const ag2 = await api("/api/agents", {
      method: "POST",
      cookie: other.cookie,
      body: { name: "zzkick3" + uniqHandle().slice(-6), serverId: otherComp.serverId },
    });
    const notHere = await api(`/api/orgs/${org.id}/agents/${ag2.data.agent.id}`, {
      method: "DELETE",
      cookie: u.cookie,
    });
    expect(notHere.status).toBe(404);

    const missing = await api(`/api/orgs/${org.id}/agents/${randomUUID()}`, { method: "DELETE", cookie: u.cookie });
    expect(missing.status).toBe(404);
    const bad = await api(`/api/orgs/${org.id}/agents/not-a-uuid`, { method: "DELETE", cookie: u.cookie });
    expect(bad.status).toBe(400);
  });

  it("属主无其他 owned server → 踢出 409（无落点拒动）", async () => {
    const u = await registerUser();
    const agentOwner = await registerUser();
    const org = await createOrg(u.cookie, "zz_test_kick_nohome");

    // agentOwner 建 agent 在自己 owned server，再 SQL 挂进 u 的 org
    const comp = await ensureTestComputer(agentOwner);
    const ag = await api("/api/agents", {
      method: "POST",
      cookie: agentOwner.cookie,
      body: { name: "zznohome" + uniqHandle().slice(-6), serverId: comp.serverId },
    });
    expect(ag.status).toBe(200);
    const agentId = ag.data.agent.id as string;
    await sql`UPDATE agents SET server_id = ${org.id} WHERE id = ${agentId}`;

    // 删掉 agentOwner 的 owned server（agent 已不在其中，可删）——属主落点归零
    const del = await api(`/api/orgs/${comp.serverId}`, { method: "DELETE", cookie: agentOwner.cookie });
    expect(del.status).toBe(200);

    const kick = await api(`/api/orgs/${org.id}/agents/${agentId}`, { method: "DELETE", cookie: u.cookie });
    expect(kick.status).toBe(409);
    // agent 原样留在 u 的 org（踢出未生效）
    const rows = await sql`SELECT server_id FROM agents WHERE id = ${agentId}`;
    expect(String(rows[0].server_id)).toBe(org.id);
  });
});
