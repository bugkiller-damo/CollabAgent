import { afterAll, describe, expect, it } from "vitest";
import { api, BASE, cleanupTestData, closeSql, registerUser, sql, type TestUser, uniqHandle } from "./helpers.js";

// 2026-09-17 用户级可见性审计修复回归测试：
// 附件绑定授权 / @提及通知过滤 / resolve 收口 / meta 白名单 / join 成员门槛。

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

const call = (u: TestUser, path: string, method = "GET", body?: unknown) =>
  api(path, { method, cookie: u.cookie, csrf: u.csrf, body });

const uploadProbe = async (u: TestUser, name: string, content: string) => {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type: "text/plain" }), name);
  const r = await fetch(BASE + "/api/attachments/upload", {
    method: "POST",
    headers: { cookie: u.cookie, "x-csrf-token": u.csrf },
    body: fd,
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { attachmentId: string }).attachmentId;
};

/**
 * 直插一个「不属于任何社区」的用户并登录——2026-09-17 收紧后注册会自动加入
 * 默认社区，走 registerUser 拿到的用户天然是 server 成员，造不出「非成员」
 * 口径；这里绕过注册事务直插 users 行再登录（handle 带 zz_test_ 前缀，
 * cleanupTestData 正常回收）。
 */
const makeOutsider = async () => {
  const handle = "zz_test_out_" + uniqHandle().slice(-6);
  const hash = (await import("bcryptjs")).default.hashSync("Test1234", 10);
  await sql`INSERT INTO users (handle, display_name, email, password_hash)
            VALUES (${handle}, ${handle}, ${handle + "@test.local"}, ${hash})`;
  const login = await api("/api/auth/login", { method: "POST", body: { login: handle, password: "Test1234" } });
  expect(login.status).toBe(200);
  return { handle, cookie: login.cookieHeader };
};

// 附件绑定授权
const idorBlock = async () => {
  const alice = await registerUser();
  const bob = await registerUser();
  const ch = await call(alice, "/api/channels", "POST", { name: "zz_test_vh_" + uniqHandle(), type: "private" });
  const chId = ch.data.channel.id as string;
  const attId = await uploadProbe(alice, "zz-vh.txt", "vh probe bytes");
  await call(alice, "/api/messages/send", "POST", {
    target: "#" + ch.data.channel.name,
    content: "with attachment",
    attachmentIds: [attId],
  });
  return { alice, bob, attId, chId };
};

describe("visibility hardening: attachment bind authorization", () => {
  it("他人频道附件不可重绑进自己的频道（无权 id 静默过滤 + 直读 403）", async () => {
    const { bob, attId } = await idorBlock();
    const bobCh = await call(bob, "/api/channels", "POST", { name: "zz_test_vh_" + uniqHandle(), type: "public" });
    const r = await call(bob, "/api/messages/send", "POST", {
      target: "#" + bobCh.data.channel.name,
      content: "steal",
      attachmentIds: [attId],
    });
    expect(r.status).toBe(200);
    expect(r.data.attachments ?? []).toEqual([]); // 无权 id 被过滤，不绑定
    expect((await api(`/api/attachments/${attId}`, { cookie: bob.cookie })).status).toBe(403);
  });

  it("上传者本人重发自己的附件 → 正常绑定", async () => {
    const { alice, attId } = await idorBlock();
    const ch2 = await call(alice, "/api/channels", "POST", { name: "zz_test_vh_" + uniqHandle(), type: "public" });
    const r = await call(alice, "/api/messages/send", "POST", {
      target: "#" + ch2.data.channel.name,
      content: "own attachment ok",
      attachmentIds: [attId],
    });
    expect(r.status).toBe(200);
    expect(r.data.attachments ?? []).toHaveLength(1);
  });
});

describe("visibility hardening: @mention notification filter", () => {
  it("私有频道 @非成员 → 不产生通知", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const ch = await call(alice, "/api/channels", "POST", { name: "zz_test_vh_" + uniqHandle(), type: "private" });
    await call(alice, "/api/messages/send", "POST", {
      target: "#" + ch.data.channel.name,
      content: `@${bob.handle} secret-preview`,
    });
    const n = await api("/api/notifications", { cookie: bob.cookie });
    const items = (n.data.items ?? n.data.notifications ?? []) as any[];
    expect(items.filter((x) => x.type === "@mention")).toEqual([]);
  });
});

describe("visibility hardening: resolve / meta / join", () => {
  it("GET /api/channels/resolve 私有频道按名解析 → 404（成员 200）", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const name = "zz_test_vh_" + uniqHandle();
    await call(alice, "/api/channels", "POST", { name, type: "private" });
    const r404 = await api(`/api/channels/resolve?target=${encodeURIComponent("#" + name)}`, { cookie: bob.cookie });
    expect(r404.status).toBe(404);
    const r200 = await api(`/api/channels/resolve?target=${encodeURIComponent("#" + name)}`, { cookie: alice.cookie });
    expect(r200.status).toBe(200);
  });

  it("?meta=1 白名单：不泄漏 storage_url / storage_key / thumb_key", async () => {
    const alice = await registerUser();
    const attId = await uploadProbe(alice, "zz-vh-meta.txt", "meta probe");
    const r = await api(`/api/attachments/${attId}?meta=1`, { cookie: alice.cookie });
    expect(r.status).toBe(200);
    const body = r.data as Record<string, unknown>;
    expect(body.storage_url ?? body.storageUrl).toBeUndefined();
    expect(body.storage_key ?? body.storageKey).toBeUndefined();
    expect(body.thumb_key ?? body.thumbKey).toBeUndefined();
    expect(body.id).toBe(attId);
  });

  it("无 server 成员身份的用户 join 公开频道 → 403", async () => {
    const alice = await registerUser();
    const ch = await call(alice, "/api/channels", "POST", { name: "zz_test_vh_" + uniqHandle(), type: "public" });
    const outsider = await makeOutsider();
    const r = await api(`/api/channels/${ch.data.channel.id}/join`, { method: "POST", cookie: outsider.cookie });
    expect(r.status).toBe(403);
  });
});

describe("visibility hardening: 公开频道 server 成员口径（canAccessChannel 收紧）", () => {
  // 注意读路径口径：messages.ts 的 accessOptsOf 在单租户降级模式显式传
  // enforceServerMembership: false——「存量豁免」刻意保留（本地账号即社区成员），
  // 收紧生效在 resolve（无豁免参数的统一判定）与 join/agent 侧。
  it("非 server 成员：降级读路径放行（存量豁免），resolve 收紧 → 404", async () => {
    const outsider = await makeOutsider();
    const list = await api("/api/messages?channel=" + encodeURIComponent("#general"), { cookie: outsider.cookie });
    expect(list.status).toBe(200); // 单租户降级读路径的存量豁免（刻意保留）
    const res = await api(`/api/channels/resolve?target=${encodeURIComponent("#general")}`, {
      cookie: outsider.cookie,
    });
    expect(res.status).toBe(404);
  });

  it("被频道管理员邀请入圈的非 server 成员：成员行放行（跨社区协作语义保留）", async () => {
    const alice = await registerUser();
    const ch = await call(alice, "/api/channels", "POST", { name: "zz_test_vh_" + uniqHandle(), type: "public" });
    const outsider = await makeOutsider();
    // 邀请前：resolve 收紧判定（成员行 + server 成员都不沾）→ 404
    expect(
      (
        await api(`/api/channels/resolve?target=${encodeURIComponent("#" + ch.data.channel.name)}`, {
          cookie: outsider.cookie,
        })
      ).status,
    ).toBe(404);
    const invite = await call(alice, `/api/channels/${ch.data.channel.id}/invite`, "POST", {
      handle: outsider.handle,
    });
    expect(invite.status).toBe(200);
    // 邀请后：成员行即可访问（无需 server 成员身份）
    const res = await api(`/api/channels/resolve?target=${encodeURIComponent("#" + ch.data.channel.name)}`, {
      cookie: outsider.cookie,
    });
    expect(res.status).toBe(200);
  });

  it("非 server 成员名下 agent 写默认社区公开频道 → 403（agentCanAccessChannel 同口径）", async () => {
    const outsider = await makeOutsider();
    // agent 落在 outsider 个人空间；#general 经默认社区兜底可解析，但访问判定拒绝
    const ag = await api("/api/agents", {
      method: "POST",
      cookie: outsider.cookie,
      body: { name: "zz_out_ag_" + uniqHandle().slice(-6) },
    });
    expect(ag.status).toBe(200);
    const r = await api(`/internal/agent/${ag.data.agent.id}/send`, {
      method: "POST",
      cookie: outsider.cookie,
      body: { target: "#general", content: "cross-boundary write" },
    });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("no access");
  });
});

describe("visibility hardening: consent_channel_invite（公开频道 @自动入圈收窄）", () => {
  it("同 server 的他人 agent 未开 consent → @ 不入圈不唤醒；开后入圈", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    // alice 的 agent 建到默认社区（与 bob 的频道同 server——收窄前这一条件即自动入圈）
    const gen = await api(`/api/channels/resolve?target=${encodeURIComponent("#general")}`, { cookie: alice.cookie });
    expect(gen.status).toBe(200);
    const serverId = gen.data.server_id as string;
    const agentName = "zzconsent" + uniqHandle().slice(-6);
    const ag = await call(alice, "/api/agents", "POST", { name: agentName, serverId });
    expect(ag.status).toBe(200);
    const agentId = ag.data.agent.id as string;

    const ch = await call(bob, "/api/channels", "POST", { name: "zz_test_vh_" + uniqHandle(), type: "public" });
    const chId = ch.data.channel.id as string;
    const memberRows = () =>
      sql`SELECT 1 FROM channel_members WHERE channel_id = ${chId} AND member_id = ${agentId} AND member_type = 'agent'`;

    // 未开 consent：bob @ 该 agent → 不入圈（收窄前 server_id 同社区即入圈）
    const s1 = await call(bob, "/api/messages/send", "POST", {
      target: "#" + ch.data.channel.name,
      content: `@${agentName} hi`,
    });
    expect(s1.status).toBe(200);
    expect((await memberRows()).length).toBe(0);

    // PATCH 校验：非布尔 → 400
    expect((await call(alice, `/api/agents/${agentId}`, "PATCH", { consentChannelInvite: "yes" })).status).toBe(400);
    expect((await call(alice, `/api/agents/${agentId}`, "PATCH", { allowTerminalWatch: 1 })).status).toBe(400);

    // 属主 opt-in 后：同一发送者 @ → 自动入圈
    expect((await call(alice, `/api/agents/${agentId}`, "PATCH", { consentChannelInvite: true })).status).toBe(200);
    const s2 = await call(bob, "/api/messages/send", "POST", {
      target: "#" + ch.data.channel.name,
      content: `@${agentName} again`,
    });
    expect(s2.status).toBe(200);
    expect((await memberRows()).length).toBe(1);
  });
});
