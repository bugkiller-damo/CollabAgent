import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, registerUser, cleanupTestData, closeSql, type TestUser } from "./helpers.js";

// 2026-07-17 安全修复的回归测试：
// 1. @提及 用户通知（split(/s+/) 正则 bug 修复后必须真正发通知）
// 2. 附件下载访问控制（未认证 401 / 非频道成员 403 / 成员 200）
// 3. 私有频道禁止自主 join
// 4. reminders IDOR（他人提醒读/改/删一律 404）

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await registerUser();
  bob = await registerUser();
  // alice 建一个私有频道供 join/附件测试
  await api("/api/channels", { method: "POST", cookie: alice.cookie, body: { name: "sec-fix-priv", description: "回归测试", visibility: "private" } });
});

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("security fixes 2026-07-17", () => {
  it("@提及用户应产生 notification（split 正则回归）", async () => {
    const send = await api("/api/messages/send", {
      method: "POST", cookie: alice.cookie,
      body: { target: "#general", content: `hi @${bob.handle} 看一下这个` },
    });
    expect(send.status).toBe(200);
    const notifs = await api("/api/notifications", { cookie: bob.cookie });
    expect(notifs.status).toBe(200);
    const list = (notifs.data.notifications || notifs.data.items || []) as any[];
    const hit = list.find((n) => n.type === "@mention" && String(n.message_id || "") === String(send.data.messageId));
    expect(hit, "bob 应收到 @mention 通知").toBeTruthy();
  });

  it("附件：未认证 401 / 非成员 403 / 频道成员可下载", async () => {
    // alice 上传一个 txt 附件
    const fd = new FormData();
    fd.append("file", new Blob(["hello attachment"], { type: "text/plain" }), "sec-note.txt");
    const csrf = alice.cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith("csrf_token="))?.split("=")[1] || "";
    const up = await fetch("http://localhost:3001/api/attachments/upload", {
      method: "POST",
      headers: { cookie: alice.cookie, "x-csrf-token": decodeURIComponent(csrf) },
      body: fd,
    });
    expect(up.status).toBe(200);
    const uploaded = (await up.json()) as { attachmentId: string };

    // 挂到私有频道消息上
    const send = await api("/api/messages/send", {
      method: "POST", cookie: alice.cookie,
      body: { target: "#sec-fix-priv", content: "附件来了", attachmentIds: [uploaded.attachmentId] },
    });
    expect(send.status).toBe(200);

    // 未认证 → 401
    const anon = await api(`/api/attachments/${uploaded.attachmentId}?meta=1`);
    expect(anon.status).toBe(401);
    // bob（非私有频道成员）→ 403
    const forbidden = await api(`/api/attachments/${uploaded.attachmentId}?meta=1`, { cookie: bob.cookie });
    expect(forbidden.status).toBe(403);
    // alice（上传者+频道 owner）→ 200
    const ok = await api(`/api/attachments/${uploaded.attachmentId}?meta=1`, { cookie: alice.cookie });
    expect(ok.status).toBe(200);
  });

  it("私有频道禁止自主 join（403），公开频道可以", async () => {
    const ch = await api("/api/channels/resolve?target=" + encodeURIComponent("#sec-fix-priv"), { cookie: alice.cookie });
    expect(ch.status).toBe(200);
    const channelId = ch.data.id;

    const joinPriv = await api(`/api/channels/${channelId}/join`, { method: "POST", cookie: bob.cookie, body: {} });
    expect(joinPriv.status).toBe(403);

    await api("/api/channels", { method: "POST", cookie: alice.cookie, body: { name: "sec-fix-pub", visibility: "public" } });
    const pub = await api("/api/channels/resolve?target=" + encodeURIComponent("#sec-fix-pub"), { cookie: alice.cookie });
    const joinPub = await api(`/api/channels/${pub.data.id}/join`, { method: "POST", cookie: bob.cookie, body: {} });
    expect(joinPub.status).toBe(200);
  });

  it("reminders：他人提醒读/改/删一律 404（IDOR 修复）", async () => {
    const created = await api("/api/reminders", {
      method: "POST", cookie: alice.cookie,
      body: { title: "alice 的提醒", delaySeconds: 3600 },
    });
    expect(created.status).toBe(200);
    const rid = created.data.reminder.id;

    expect((await api(`/api/reminders/${rid}`, { cookie: bob.cookie })).status).toBe(404);
    expect((await api(`/api/reminders/${rid}`, { method: "PATCH", cookie: bob.cookie, body: { title: "hijack" } })).status).toBe(404);
    expect((await api(`/api/reminders/${rid}`, { method: "DELETE", cookie: bob.cookie })).status).toBe(404);
    expect((await api(`/api/reminders/${rid}/log`, { cookie: bob.cookie })).status).toBe(404);
    // 本人正常
    expect((await api(`/api/reminders/${rid}`, { cookie: alice.cookie })).status).toBe(200);
  });

  it("机器令牌：sha256 签发后可直接认证（快路径）", async () => {
    const mint = await api("/api/profile/machine-token", { method: "POST", cookie: alice.cookie, body: {} });
    expect(mint.status).toBe(200);
    const token = mint.data.token as string;
    expect(token.startsWith("sk_machine_")).toBe(true);
    // 用新令牌调一个需认证的端点
    const me = await api("/api/users", { cookie: `x=1`, csrf: false, token: undefined, });
    expect(me.status).toBe(401); // 无 cookie 仍 401
    const authed = await fetch("http://localhost:3001/api/users", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(200);
    // 吊销后立即失效
    const tokens = await api("/api/profile/tokens", { cookie: alice.cookie });
    const row = (tokens.data.tokens as any[]).find((t) => token.startsWith(t.prefix));
    if (row) {
      await api(`/api/profile/tokens/${row.id}`, { method: "DELETE", cookie: alice.cookie });
      const revoked = await fetch("http://localhost:3001/api/users", { headers: { authorization: `Bearer ${token}` } });
      expect(revoked.status).toBe(401);
    }
  });

  it("会话吊销后旧 access cookie 立即失效（JWT 状态回查）", async () => {
    const carol = await registerUser();
    // carol 当前 cookie 可用
    const before = await api("/api/users", { cookie: carol.cookie });
    expect(before.status).toBe(200);
    // logout-all 吊销所有会话
    const out = await api("/api/auth/logout-all", { method: "POST", cookie: carol.cookie });
    expect(out.status).toBe(200);
    // 旧 cookie 立即 401
    const after = await api("/api/users", { cookie: carol.cookie });
    expect(after.status).toBe(401);
  });

  it("私有频道 @非成员 agent：不自动入圈，mentionAgents 为空（daemon 不会唤醒）", async () => {
    // alice 创建 agent（落在个人 org，与频道跨 server）
    const ag = await api("/api/agents", {
      method: "POST", cookie: alice.cookie,
      body: { name: "secbot", runtime: "claude", model: "sonnet" },
    });
    expect(ag.status).toBe(200);

    // alice 浏览器 WS 收听投递
    const { WebSocket } = await import("ws");
    const ws = new WebSocket("ws://localhost:3001/ws", { headers: { Cookie: alice.cookie } });
    await new Promise((res) => ws.once("message", res)); // connected
    const deliver = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 8000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "agent:deliver" && msg.message?.content?.includes("@secbot")) {
          clearTimeout(t); resolve(msg);
        }
      });
    });

    const send = await api("/api/messages/send", {
      method: "POST", cookie: alice.cookie,
      body: { target: "#sec-fix-priv", content: "@secbot 你好" },
    });
    expect(send.status).toBe(200);

    const msg = await deliver;
    // 私有频道：@ 不入圈 → mentionAgents 为空数组，daemon 端据此不 spawn
    expect(Array.isArray(msg.message.mentionAgents)).toBe(true);
    expect(msg.message.mentionAgents).toHaveLength(0);
    ws.close();

    // 成员列表里不应有该 agent
    const ch = await api("/api/channels/resolve?target=" + encodeURIComponent("#sec-fix-priv"), { cookie: alice.cookie });
    const members = await api(`/api/channels/${ch.data.id}/members`, { cookie: alice.cookie });
    const agentMember = (members.data.members as any[]).find((m) => m.member_type === "agent" && m.handle === "secbot");
    expect(agentMember).toBeUndefined();
  });

  it("公开频道 @发送者名下 agent：自动入圈且 mentionAgents 包含它", async () => {
    await api("/api/channels", { method: "POST", cookie: alice.cookie, body: { name: "sec-fix-pub2", visibility: "public" } });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket("ws://localhost:3001/ws", { headers: { Cookie: alice.cookie } });
    await new Promise((res) => ws.once("message", res));
    const deliver = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 8000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "agent:deliver" && msg.message?.content?.includes("@secbot")) {
          clearTimeout(t); resolve(msg);
        }
      });
    });

    const send = await api("/api/messages/send", {
      method: "POST", cookie: alice.cookie,
      body: { target: "#sec-fix-pub2", content: "@secbot hello" },
    });
    expect(send.status).toBe(200);

    const msg = await deliver;
    expect(msg.message.mentionAgents).toContain("secbot");
    ws.close();

    // 公开频道：自动入圈（发送者名下 agent 跨 server 也生效，与 /invite 回退一致）
    const ch = await api("/api/channels/resolve?target=" + encodeURIComponent("#sec-fix-pub2"), { cookie: alice.cookie });
    const members = await api(`/api/channels/${ch.data.id}/members`, { cookie: alice.cookie });
    const agentMember = (members.data.members as any[]).find((m) => m.member_type === "agent" && m.handle === "secbot");
    expect(agentMember).toBeTruthy();
  });

  it("公开频道 @中文名 agent：mentionAgents 正确包含（中文名不被 ASCII 正则剥光）", async () => {
    // 复刻线上 bug：agent 名含数字+中文，旧的 handle 解析会把 "716测试机" 剥成 "716" 查无此人
    const ag = await api("/api/agents", {
      method: "POST", cookie: alice.cookie,
      body: { name: "716测试机", runtime: "claude", model: "sonnet" },
    });
    expect(ag.status).toBe(200);

    await api("/api/channels", { method: "POST", cookie: alice.cookie, body: { name: "sec-fix-pub3", visibility: "public" } });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket("ws://localhost:3001/ws", { headers: { Cookie: alice.cookie } });
    await new Promise((res) => ws.once("message", res));
    const deliver = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 8000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "agent:deliver" && msg.message?.content?.includes("716测试机")) {
          clearTimeout(t); resolve(msg);
        }
      });
    });

    const send = await api("/api/messages/send", {
      method: "POST", cookie: alice.cookie,
      body: { target: "#sec-fix-pub3", content: "@716测试机 你好" },
    });
    expect(send.status).toBe(200);

    const msg = await deliver;
    expect(msg.message.mentionAgents).toContain("716测试机");
    ws.close();
  });
});
