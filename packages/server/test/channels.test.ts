import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  cleanupTestData,
  closeSql,
  ensureTestComputer,
  makeOrgOwner,
  registerUser,
  uniqHandle,
} from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("channels: 创建 / 列取 / 成员 / 权限 / 邀请 / DM", () => {
  let ck: string, cs: string, adminChId: string, ckUid: string, defaultServerId: string;
  const testCh = "ch_test_" + Date.now().toString(36);

  beforeAll(async () => {
    const u = await registerUser();
    // 2026-09-18 权限模型：建频道收敛 server owner——ck 的频道都建在默认社区，
    // 立其为默认社区 owner（isInstanceAdmin 同口径）
    defaultServerId = await makeOrgOwner(u);
    ck = u.cookie;
    cs = u.csrf;
    ckUid = u.userId;
    // 建一个测试用户为 owner 的频道，供管理操作测试
    const adminCh = await api("/api/channels", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: "admin_ch_" + Date.now().toString(36) },
    });
    adminChId = adminCh.data.channel.id;
  });

  it("列取公开频道含 general", async () => {
    const r = await api("/api/channels", { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.channels.length).toBeGreaterThanOrEqual(3);
    expect(r.data.channels.map((c: any) => c.name)).toContain("general");
  });

  it("创建频道", async () => {
    const r = await api("/api/channels", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: testCh, description: "t" },
    });
    expect(r.status).toBe(200);
    expect(r.data.channel.name).toBe(testCh);
  });

  it("member 建频道 → 403（2026-09-18：建频道收敛 server owner）", async () => {
    // 注册用户自动入圈广场但只是 member——不可建频道
    const m = await registerUser();
    const r = await api("/api/channels", {
      method: "POST",
      cookie: m.cookie,
      csrf: m.csrf,
      body: { name: "m_ch_" + Date.now().toString(36) },
    });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("only org owner can create channels");
  });

  it("重复名 409", async () => {
    expect((await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: testCh } })).status).toBe(
      409,
    );
  });

  it("大小写变体重名 409（P1.32：与 lower(name) 唯一索引同口径）", async () => {
    // testCh 已建；此前原值口径检查会让大小写变体双过、撞唯一索引 500
    const upper = testCh.toUpperCase();
    expect(upper).not.toBe(testCh); // 名字含字母，变体确实不同
    const r = await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: upper } });
    expect(r.status).toBe(409);
  });

  it("并发大小写变体双建恰一成功（P1.32：23505 → 409，无 500）", async () => {
    const base = "race_" + Date.now().toString(36);
    const [a, b] = await Promise.all([
      api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: base } }),
      api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: base.toUpperCase() } }),
    ]);
    // 无论 SELECT 口径还是 23505 兜底截住，结果都是恰一 200 一 409
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("非法 type 400（P1.32：dm/任意字符串拒建）", async () => {
    const n = "badtype_" + Date.now().toString(36);
    for (const bad of ["dm", "weird", "PUBLIC"]) {
      expect(
        (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: n, type: bad } })).status,
      ).toBe(400);
      expect(
        (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: n, visibility: bad } }))
          .status,
      ).toBe(400);
    }
  });

  it("PATCH 非法 type 400（P1.32）", async () => {
    expect(
      (await api(`/api/channels/${adminChId}`, { method: "PATCH", cookie: ck, csrf: cs, body: { type: "dm" } })).status,
    ).toBe(400);
    // 合法值不受影响
    expect(
      (await api(`/api/channels/${adminChId}`, { method: "PATCH", cookie: ck, csrf: cs, body: { type: "private" } }))
        .status,
    ).toBe(200);
  });

  it("name 超长 400（P1.32：VARCHAR(100) 预检，不放行至 22001 500）", async () => {
    expect(
      (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: "x".repeat(101) } })).status,
    ).toBe(400);
  });

  it("无 name 400", async () => {
    expect((await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { desc: "x" } })).status).toBe(
      400,
    );
  });

  it("更新自己创建的频道描述", async () => {
    const r = await api(`/api/channels/${adminChId}`, {
      method: "PATCH",
      cookie: ck,
      csrf: cs,
      body: { description: "upd" },
    });
    expect(r.status).toBe(200);
    expect(r.data.channel.description).toBe("upd");
  });

  it("频道成员列表字段完整", async () => {
    const r = await api(`/api/channels/${adminChId}/members`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.members[0]).toHaveProperty("member_id");
    expect(r.data.members[0]).toHaveProperty("role");
  });

  it("邀请用户到频道", async () => {
    const o = await registerUser();
    expect(
      (
        await api(`/api/channels/${adminChId}/invite`, {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { handle: o.handle },
        })
      ).status,
    ).toBe(200);
  });

  it("可邀请候选：同 server 人类成员，剔除已入圈者；非管理员 403", async () => {
    // adminChId 在默认社区；新注册用户自动入圈默认社区（member）
    const invited = await registerUser();
    const pending = await registerUser();
    expect(
      (
        await api(`/api/channels/${adminChId}/invite`, {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { handle: invited.handle },
        })
      ).status,
    ).toBe(200);
    const r = await api(`/api/channels/${adminChId}/invitable`, { cookie: ck });
    expect(r.status).toBe(200);
    const handles = (r.data.candidates as any[]).map((c) => c.handle);
    expect(handles).toContain(pending.handle);
    expect(handles).not.toContain(invited.handle); // 已入圈剔除
    // server member 但非频道管理员 → 403（与 /invite 同口径 canManageChannel）
    expect((await api(`/api/channels/${adminChId}/invitable`, { cookie: pending.cookie })).status).toBe(403);
  });

  it("可邀请候选含本 server agent 与属主自带的异 server agent", async () => {
    // 同 server agent。sameName 用裸 uniqHandle（zz_test_ 前缀）：同名人类的
    // handle 走同一前缀才能被 cleanupTestData 回收（加 "inv_" 前缀会漏清）
    const comp = await ensureTestComputer({ userId: ckUid, cookie: ck }, defaultServerId);
    const sameName = uniqHandle();
    const sameAgent = await api("/api/agents", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: sameName, serverId: comp.serverId },
    });
    expect(sameAgent.status).toBe(200);
    const sameAgentId = String(sameAgent.data.agent.id);
    // 同名碰撞：注册 handle 完全相同的 human（自动入默认 server member），
    // 使 legacy handle 解析在该频道上同时命中 human 与 agent
    const sameHuman = await registerUser(sameName);
    // 异 server 但属主是自己的 agent（/invite 的属主兜底口径）
    const ownComp = await ensureTestComputer({ userId: ckUid, cookie: ck });
    const ownName = "inv_" + uniqHandle();
    expect(ownComp.serverId).not.toBe(comp.serverId);
    expect(
      (
        await api("/api/agents", {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { name: ownName, serverId: ownComp.serverId },
        })
      ).status,
    ).toBe(200);
    const r = await api(`/api/channels/${adminChId}/invitable`, { cookie: ck });
    expect(r.status).toBe(200);
    const cands = r.data.candidates as any[];
    // 同 handle 的 human 与 agent 候选须同时出现
    expect(String(cands.find((c) => c.handle === sameName && c.member_type === "agent")?.member_id)).toBe(sameAgentId);
    expect(String(cands.find((c) => c.handle === sameName && c.member_type === "human")?.member_id)).toBe(
      sameHuman.userId,
    );
    expect(cands.find((c) => c.handle === ownName)?.member_type).toBe("agent");
    // 精确目标邀请：memberId+memberType 定向到 agent，不被同名 human 截胡
    expect(
      (
        await api(`/api/channels/${adminChId}/invite`, {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { handle: sameName, memberId: sameAgentId, memberType: "agent" },
        })
      ).status,
    ).toBe(200);
    // /members：入圈的是该 id 的 agent，同名 human 未入圈
    const members = await api(`/api/channels/${adminChId}/members`, { cookie: ck });
    const rows = members.data.members as any[];
    expect(rows.some((m) => String(m.member_id) === sameAgentId && m.member_type === "agent")).toBe(true);
    expect(rows.some((m) => String(m.member_id) === String(sameHuman.userId) && m.member_type === "human")).toBe(false);
    // 再查 /invitable：agent 精确候选剔除，同名 human 候选仍保留
    const after = await api(`/api/channels/${adminChId}/invitable`, { cookie: ck });
    const afterCands = after.data.candidates as any[];
    expect(afterCands.find((c) => c.handle === sameName && c.member_type === "agent")).toBeFalsy();
    expect(String(afterCands.find((c) => c.handle === sameName && c.member_type === "human")?.member_id)).toBe(
      sameHuman.userId,
    );
  });

  it("邀请非本 server 成员的注册用户 → 403；先加进 server 再邀即可（2026-09-20 invite 收口）", async () => {
    // ck 的私有 org：目标用户只自动入圈了默认社区，不在该 server
    const own = await api("/api/orgs", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: "own_" + uniqHandle() },
    });
    const orgId = own.data.org.id;
    const ch = await api("/api/channels", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: "n_" + uniqHandle(), serverId: orgId },
    });
    const outsider = await registerUser(); // 只在默认社区
    const denied = await api(`/api/channels/${ch.data.channel.id}/invite`, {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { handle: outsider.handle },
    });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toBe("user is not a member of that server");
    // 先加入 server → 频道邀请放行
    expect(
      (
        await api(`/api/orgs/${orgId}/members`, {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { handle: outsider.handle },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(`/api/channels/${ch.data.channel.id}/invite`, {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { handle: outsider.handle },
        })
      ).status,
    ).toBe(200);
  });

  it("邀请不存在的用户 404", async () => {
    expect(
      (
        await api(`/api/channels/${adminChId}/invite`, {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { handle: "nobody_xyz" },
        })
      ).status,
    ).toBe(404);
  });

  it("通过名字解析频道", async () => {
    const r = await api("/api/channels/resolve?target=" + encodeURIComponent("#general"), { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.name).toBe("general");
  });

  it("解析 DM", async () => {
    const o = await registerUser();
    const r = await api(`/api/channels/resolve?target=${encodeURIComponent("dm:@" + o.handle)}`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.type).toBe("dm");
    expect(r.data.peer).toBeTruthy();
  });

  it("不存在的频道 404", async () => {
    expect(
      (await api("/api/channels/resolve?target=" + encodeURIComponent("#noexist123"), { cookie: ck })).status,
    ).toBe(404);
  });

  it("DM 列表", async () => {
    const o = await registerUser();
    await api("/api/messages/send", { method: "POST", cookie: ck, body: { target: `dm:@${o.handle}`, content: "hi" } });
    const r = await api("/api/channels/dms", { cookie: ck });
    expect(r.status).toBe(200);
    if (r.data.dms.length) expect(r.data.dms[0]).toHaveProperty("peerHandle");
  });

  it("加入频道", async () => {
    const n = "join_" + Date.now().toString(36);
    const ch = (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: n } })).data.channel;
    const o = await registerUser();
    expect((await api(`/api/channels/${ch.id}/join`, { method: "POST", cookie: o.cookie, csrf: o.csrf })).status).toBe(
      200,
    );
  });

  it("join 忽略 body.memberType，服务端定死 human（P1.32）", async () => {
    const n = "joinmt_" + Date.now().toString(36);
    const ch = (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: n } })).data.channel;
    const o = await registerUser();
    // 恶意/误传 memberType:'agent'——人类不可自登记为 agent（此前原样入库污染 member_type 假设）
    expect(
      (
        await api(`/api/channels/${ch.id}/join`, {
          method: "POST",
          cookie: o.cookie,
          csrf: o.csrf,
          body: { memberType: "agent" },
        })
      ).status,
    ).toBe(200);
    const members = await api(`/api/channels/${ch.id}/members`, { cookie: ck });
    const row = (members.data.members as any[]).find((m) => m.handle === o.handle);
    expect(row).toBeTruthy();
    expect(row.member_type).toBe("human");
  });

  it("离开频道", async () => {
    const n = "leave_" + Date.now().toString(36);
    const ch = (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: n } })).data.channel;
    expect((await api(`/api/channels/${ch.id}/leave`, { method: "POST", cookie: ck, csrf: cs })).status).toBe(200);
  });

  it("服务器信息", async () => {
    const r = await api(
      "/api/channels/server?serverId=" + ((await (await api("/api/orgs", { cookie: ck })).data.orgs[0]?.id) || ""),
      { cookie: ck },
    );
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("channels");
    expect(r.data).toHaveProperty("humans");
  });

  it("服务器信息：同 server 非成员不可枚举私有频道（P0.9 回归）", async () => {
    // 注册不自动加入默认 server，故用 ck 的个人 org 作共享 server：ck 是 owner，把另一用户加为 member
    const orgId = (await (await api("/api/orgs", { cookie: ck })).data.orgs[0]?.id) || "";
    const other = await registerUser();
    expect(
      (
        await api(`/api/orgs/${orgId}/members`, {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { handle: other.handle },
        })
      ).status,
    ).toBe(200);
    // ck 在该 server 建私有频道（创建者自动以 owner 角色入圈）
    const privName = "priv_" + Date.now().toString(36);
    expect(
      (
        await api("/api/channels", {
          method: "POST",
          cookie: ck,
          csrf: cs,
          body: { name: privName, type: "private", serverId: orgId },
        })
      ).status,
    ).toBe(200);
    // 频道成员（owner）可见
    const mine = await api("/api/channels/server?serverId=" + orgId, { cookie: ck });
    expect(mine.status).toBe(200);
    expect(mine.data.channels.map((c: any) => c.name)).toContain(privName);
    // 同 server 成员但非频道成员：通过 server 成员校验（200），但私有频道不可枚举
    const theirs = await api("/api/channels/server?serverId=" + orgId, { cookie: other.cookie });
    expect(theirs.status).toBe(200);
    expect(theirs.data.channels.map((c: any) => c.name)).not.toContain(privName);
  });

  it("删除频道", async () => {
    const n = "del_" + Date.now().toString(36);
    const ch = (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: n } })).data.channel;
    expect((await api(`/api/channels/${ch.id}`, { method: "DELETE", cookie: ck, csrf: cs })).status).toBe(200);
  });
});
