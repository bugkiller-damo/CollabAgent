import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { api, BASE, cleanupTestData, closeSql, registerUser, sql, uniqHandle } from "./helpers.js";

const WS_BASE = BASE.replace(/^http/, "ws") + "/ws";

// ── WS 辅助 ──────────────────────────────────────────────

/**
 * Connect to WS endpoint and set up a message listener before `open` fires,
 * so the "connected" welcome message is never missed (avoids a race where
 * `resolveUserId` resolves synchronously for anon / invalid-JWT clients).
 *
 * @returns `{ ws, connected }` — `connected` is a Promise for the first message.
 */
function connectWs(headers?: Record<string, string>): { ws: WebSocket; connected: Promise<any> } {
  const ws = new WebSocket(WS_BASE, { headers });
  const connected = nextMessage(ws);
  ws.on("unexpected-response", (_req, res) => {
    res.resume();
  });
  return { ws, connected };
}

/**
 * Return the next JSON message from a WebSocket.
 * Rejects if the connection closes before a message arrives, or on timeout.
 */
function nextMessage(ws: WebSocket, timeout = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners("message");
      ws.removeAllListeners("close");
      reject(new Error("WS message timeout"));
    }, timeout);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch {
        resolve(raw.toString());
      }
    });
    ws.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`WS closed with code ${code} before message arrived`));
    });
  });
}

/**
 * Wait for the WebSocket to close and return the close code.
 * Must be set up before the close event fires (i.e. before connectWs resolves).
 */
function closeCode(ws: WebSocket, timeout = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS close timeout")), timeout);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once("error", () => {});
  });
}

/** Small wait for async propagation (cleanup, etc.). */
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  await tick(500); // let in-flight WS cleanup finish
  await cleanupTestData();
  await closeSql();
});

// ── Tests ────────────────────────────────────────────────

describe("WS: connection auth", () => {
  it("anonymous (no auth) is rejected with 4001", async () => {
    // 2026-07-17 安全修复：未认证浏览器连接不再降级为 anon（此前可收到公开频道全量消息）
    const ws = new WebSocket(WS_BASE);
    const code = await closeCode(ws);
    expect(code).toBe(4001);
  });

  it("valid JWT cookie authenticates as browser user", async () => {
    const u = await registerUser();
    const { ws, connected } = connectWs({ Cookie: u.cookie });
    const msg = await connected;
    expect(msg.type).toBe("connected");
    expect(msg).toHaveProperty("time");
    ws.close();
  });

  it("invalid JWT is rejected with 4001 (not silently anon)", async () => {
    const ws = new WebSocket(WS_BASE, { headers: { Cookie: "access_token=eyJhbGciOiJIUzI1NiJ9.invalid.hwis" } });
    const code = await closeCode(ws);
    expect(code).toBe(4001);
  });

  it("browser JWT 被 logout-all 吊销后 WS 握手 4001（P1.15 session 回查）", async () => {
    // 此前 WS 侧浏览器 JWT 只验签名不做会话回查，logout-all 后长连接/重连仍有效；
    // P1.15 校验收敛到 lib/auth-token.ts verifyBrowserToken（与 HTTP 共用）后，
    // 已吊销的会话在 WS 握手同样 fail-closed → 4001。
    const u = await registerUser();
    // 先确认原 cookie 握手正常（会话有效）
    const ok = connectWs({ Cookie: u.cookie });
    expect((await ok.connected).type).toBe("connected");
    ok.ws.close();
    // logout-all 吊销全部会话（cookie 本身的 JWT 在 7 天有效期内，仅会话被吊销）
    const out = await api("/api/auth/logout-all", { method: "POST", cookie: u.cookie });
    expect(out.status).toBe(200);
    // 用已吊销的旧 cookie 再握手 → 4001
    const ws = new WebSocket(WS_BASE, { headers: { Cookie: u.cookie } });
    const code = await closeCode(ws);
    expect(code).toBe(4001);
  });

  it("daemon with valid machine token connects and receives serverTime", async () => {
    const u = await registerUser();
    const tr = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: {},
    });
    expect(tr.status).toBe(200);
    const machineToken: string = tr.data.token;

    const { ws, connected } = connectWs({ Authorization: `Bearer ${machineToken}` });
    const msg = await connected;
    expect(msg.type).toBe("connected");
    // Daemon gets "serverTime" (browser gets "time")
    expect(msg).toHaveProperty("serverTime");
    ws.close();
  });

  it("daemon with invalid machine token is closed with code 4001", async () => {
    // Set up the close listener BEFORE the connection opens to avoid races
    const ws = new WebSocket(WS_BASE, {
      headers: { Authorization: "Bearer sk_machine_thisdoesnotexist0000" },
    });
    const code = await closeCode(ws);
    expect(code).toBe(4001);
  });

  it("machine token auth is case-sensitive — wrong case is not a daemon token, closed 4001", async () => {
    // "SK_MACHINE_foo" 不是合法 daemon token（前缀小写敏感），按浏览器 JWT 路径校验失败 → 拒绝
    const ws = new WebSocket(WS_BASE, { headers: { Authorization: "Bearer SK_MACHINE_foo" } });
    const code = await closeCode(ws);
    expect(code).toBe(4001);
  });
});

describe("WS: daemon ready & status", () => {
  it("daemon ready message is accepted; /api/daemon/status returns connected", async () => {
    const u = await registerUser();
    const tr = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: {},
    });
    const { ws, connected } = connectWs({ Authorization: `Bearer ${tr.data.token}` });
    await connected; // "connected"

    // Send ready metadata
    ws.send(
      JSON.stringify({
        type: "ready",
        hostname: "ws-test-host",
        daemonVersion: "0.1.0-ws-test",
        runtimes: ["node:20"],
      }),
    );

    // Give the server a tick to process
    await tick(100);

    const status = await api("/api/daemon/status", { cookie: u.cookie });
    expect(status.status).toBe(200);
    expect(status.data.connected).toBe(true);

    ws.close();
  });

  it("daemon disconnect clears status", async () => {
    const u = await registerUser();
    const tr = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: {},
    });
    const { ws, connected } = connectWs({ Authorization: `Bearer ${tr.data.token}` });
    await connected;
    expect((await api("/api/daemon/status", { cookie: u.cookie })).data.connected).toBe(true);

    ws.close();
    await tick(300); // Give cleanup time

    expect((await api("/api/daemon/status", { cookie: u.cookie })).data.connected).toBe(false);
  });

  it("daemon sends agent:status / agent:activity without errors", async () => {
    const u = await registerUser();
    const tr = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: {},
    });
    const { ws, connected } = connectWs({ Authorization: `Bearer ${tr.data.token}` });
    await connected;

    // These should be silently accepted (no crash, no error reply)
    ws.send(JSON.stringify({ type: "agent:status", status: "running" }));
    ws.send(JSON.stringify({ type: "agent:activity", activity: "processing" }));
    // Still alive after sending
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });

  it("two daemons for different users coexist", async () => {
    const u1 = await registerUser();
    const u2 = await registerUser();

    const t1 = await api("/api/profile/machine-token", { method: "POST", cookie: u1.cookie, csrf: u1.csrf, body: {} });
    const t2 = await api("/api/profile/machine-token", { method: "POST", cookie: u2.cookie, csrf: u2.csrf, body: {} });

    // Connect sequentially to avoid any WS upgrade concurrency edge case
    const { ws: ws1, connected: c1 } = connectWs({ Authorization: `Bearer ${t1.data.token}` });
    await c1;
    const { ws: ws2, connected: c2 } = connectWs({ Authorization: `Bearer ${t2.data.token}` });
    await c2;

    expect((await api("/api/daemon/status", { cookie: u1.cookie })).data.connected).toBe(true);
    expect((await api("/api/daemon/status", { cookie: u2.cookie })).data.connected).toBe(true);

    ws1.close();
    ws2.close();
  });
});

describe("WS: browser connections", () => {
  it("multiple browser tabs for the same user all broadcast-receive", async () => {
    const u = await registerUser();
    const { ws: ws1, connected: c1 } = connectWs({ Cookie: u.cookie });
    const { ws: ws2, connected: c2 } = connectWs({ Cookie: u.cookie });
    await Promise.all([c1, c2]);

    // Both should receive broadcast events
    const p1 = nextMessage(ws1);
    const p2 = nextMessage(ws2);
    await api("/api/messages/send", {
      method: "POST",
      cookie: u.cookie,
      body: { target: "#general", content: `multi-browser-${Date.now()}` },
    });
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.type).toBe("agent:deliver");
    expect(m2.type).toBe("agent:deliver");
    expect(m1.message.content).toBe(m2.message.content);

    ws1.close();
    ws2.close();
  });
});

describe("WS: broadcast delivery", () => {
  it("public channel message reaches connected browser client", async () => {
    const u = await registerUser();
    const { ws, connected } = connectWs({ Cookie: u.cookie });
    await connected;

    const content = `public-${Date.now()}`;
    const msgPromise = nextMessage(ws);
    const send = await api("/api/messages/send", {
      method: "POST",
      cookie: u.cookie,
      body: { target: "#general", content },
    });
    expect(send.status).toBe(200);

    const msg = await msgPromise;
    expect(msg.type).toBe("agent:deliver");
    expect(msg.message.content).toBe(content);
    expect(msg.message.senderId).toBe(u.userId);
    expect(msg.message.senderType).toBe("human");
    expect(msg.message.channelId).toMatch(/^#general/);

    ws.close();
  });

  it("private channel message reaches members only", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const outsider = await registerUser();

    // Resolve server id
    const chList = await api("/api/channels", { cookie: owner.cookie });
    const serverId: string = chList.data.channels[0]?.server_id;
    // O3：显式 serverId 建频道要求调用者是该 server 成员（server 级 RBAC）。
    // 注册默认只创建个人组织，需显式加入默认社区。
    await sql`INSERT INTO server_members (server_id, user_id, role) VALUES (${serverId}, ${owner.userId}, 'member') ON CONFLICT DO NOTHING`;

    // Create a private channel
    const chName = `priv-${uniqHandle()}`;
    const create = await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      body: { serverId, name: chName, type: "private" },
    });
    expect(create.status).toBe(200);
    const channelId: string = create.data.channel.id;

    // Invite member
    const invite = await api(`/api/channels/${channelId}/invite`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { handle: member.handle },
    });
    expect(invite.status).toBe(200);

    // Connect all three WS
    const { ws: wsOwner, connected: cO } = connectWs({ Cookie: owner.cookie });
    const { ws: wsMember, connected: cM } = connectWs({ Cookie: member.cookie });
    const { ws: wsOutsider, connected: cX } = connectWs({ Cookie: outsider.cookie });
    await Promise.all([cO, cM, cX]);

    const content = `private-${Date.now()}`;
    const ownerMsg = nextMessage(wsOwner);
    const memberMsg = nextMessage(wsMember);
    const outsiderMsg = nextMessage(wsOutsider);

    await api("/api/messages/send", {
      method: "POST",
      cookie: owner.cookie,
      body: { target: `#${chName}`, content },
    });

    // Owner and member receive; outsider times out
    await expect(ownerMsg).resolves.toMatchObject({
      type: "agent:deliver",
      message: { content },
    });
    await expect(memberMsg).resolves.toMatchObject({
      type: "agent:deliver",
      message: { content },
    });
    await expect(outsiderMsg).rejects.toThrow(/timeout/);

    wsOwner.close();
    wsMember.close();
    wsOutsider.close();
  });

  it("DM channel message reaches both participants only", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const c = await registerUser();

    const { ws: wsA, connected: cA } = connectWs({ Cookie: a.cookie });
    const { ws: wsB, connected: cB } = connectWs({ Cookie: b.cookie });
    const { ws: wsC, connected: cC } = connectWs({ Cookie: c.cookie });
    await Promise.all([cA, cB, cC]);

    const content = `dm-test-${Date.now()}`;
    const msgA = nextMessage(wsA);
    const msgB = nextMessage(wsB);
    const msgC = nextMessage(wsC);

    await api("/api/messages/send", {
      method: "POST",
      cookie: a.cookie,
      body: { target: `dm:@${b.handle}`, content },
    });

    // A & B receive, C (non-participant) does not
    await expect(msgA).resolves.toMatchObject({
      type: "agent:deliver",
      message: { content },
    });
    await expect(msgB).resolves.toMatchObject({
      type: "agent:deliver",
      message: { content },
    });
    await expect(msgC).rejects.toThrow(/timeout/);

    wsA.close();
    wsB.close();
    wsC.close();
  });
});
