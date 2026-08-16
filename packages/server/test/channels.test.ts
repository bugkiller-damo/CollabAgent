import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("channels: 创建 / 列取 / 成员 / 权限 / 邀请 / DM", () => {
  let ck: string, cs: string, adminChId: string;
  const testCh = "ch_test_" + Date.now().toString(36);

  beforeAll(async () => {
    const u = await registerUser();
    ck = u.cookie;
    cs = u.csrf;
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

  it("重复名 409", async () => {
    expect((await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: testCh } })).status).toBe(
      409,
    );
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

  it("删除频道", async () => {
    const n = "del_" + Date.now().toString(36);
    const ch = (await api("/api/channels", { method: "POST", cookie: ck, csrf: cs, body: { name: n } })).data.channel;
    expect((await api(`/api/channels/${ch.id}`, { method: "DELETE", cookie: ck, csrf: cs })).status).toBe(200);
  });
});
