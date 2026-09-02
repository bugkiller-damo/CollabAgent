import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { purgeReadNotifications } from "../src/lib/metrics-persist.js";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

// P1.25：通知补齐——数据驱动重写（修此前「无数据静默 return」的假绿风险）。
// 通知全部经真实链路制造：A 向 B 发 DM（POST /api/messages/send target=dm:@handle）
// → B 收到 type=dm 通知 + WS notification.new；已读端点附带 notification.read WS 广播。

const WS_BASE = (process.env.SLOCK_TEST_BASE_URL || "http://localhost:3001").replace(/^http/, "ws") + "/ws";

/** purgeReadNotifications 只依赖 app.pg.query —— 用 helpers 的 sql 构造同形假 app */
const fakeApp = {
  pg: {
    query: async (text: string, params?: unknown[]) => {
      const r = await sql.unsafe(text, (params ?? []) as any[]);
      return { rows: Array.isArray(r) ? r : [r] };
    },
  },
} as any;

function connectWs(headers: Record<string, string>): {
  ws: WebSocket;
  next: (timeout?: number) => Promise<any>;
  nextOfType: (type: string, timeout?: number) => Promise<any>;
} {
  const ws = new WebSocket(WS_BASE, { headers });
  ws.on("unexpected-response", (_req, res) => res.resume());
  // 持久收集器：连接起即挂监听，事件进队列缓冲——server 在 HTTP 响应「之前」推 WS
  // 事件（notification 先于 agent:deliver、两者先于 send 响应），若等 send 返回再挂
  // nextMessage 式监听会有一段无监听窗口丢事件（一次性 handler 模式的实锤坑）。
  const queue: any[] = [];
  const waiters: Array<{ timer: ReturnType<typeof setTimeout>; resolve: (v: any) => void }> = [];
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    // ping 帧自动回 pong 并跳过（与 ws.test.ts nextMessage 语义一致）
    if (msg && typeof msg === "object" && msg.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* ignore */
      }
      return;
    }
    queue.push(msg);
    const w = waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(queue.shift());
    }
  });
  const next = (timeout = 8000): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS message timeout")), timeout);
      if (queue.length) {
        clearTimeout(timer);
        resolve(queue.shift());
        return;
      }
      waiters.push({ timer, resolve });
    });
  const nextOfType = (type: string, timeout = 8000): Promise<any> =>
    new Promise((resolve, reject) => {
      const idx = queue.findIndex((m) => m?.type === type);
      if (idx >= 0) {
        const [hit] = queue.splice(idx, 1);
        resolve(hit);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`WS event ${type} timeout`)), timeout);
      waiters.push({
        timer,
        resolve: (msg: any) => {
          if (msg?.type === type) resolve(msg);
          else void nextOfType(type, timeout).then(resolve, reject);
        },
      });
    });
  return { ws, next, nextOfType };
}

const sendDm = (from: TestUser, toHandle: string, content: string) =>
  api("/api/messages/send", { method: "POST", cookie: from.cookie, body: { target: `dm:@${toHandle}`, content } });

async function unreadDmIds(user: TestUser): Promise<string[]> {
  const r = await api("/api/notifications?unreadOnly=true&limit=100", { cookie: user.cookie });
  return (r.data.notifications as any[]).filter((n) => n.type === "dm").map((n) => String(n.id));
}

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("notifications (P1.25 dm 通知 / 已读广播 / TTL)", () => {
  let a: TestUser, b: TestUser;

  beforeAll(async () => {
    a = await registerUser();
    b = await registerUser();
  });

  it("A 发 DM → B 收到 dm 通知（字段完整）；sender 自己不产生通知", async () => {
    const sent = await sendDm(a, b.handle, "p1.25 hello");
    expect(sent.status).toBe(200);

    const r = await api("/api/notifications", { cookie: b.cookie });
    expect(r.status).toBe(200);
    const dmNotifs = (r.data.notifications as any[]).filter((n) => n.type === "dm");
    expect(dmNotifs.length).toBeGreaterThanOrEqual(1);
    const n = dmNotifs[0];
    // REST 列表返回 DB 蛇形列名（WS notification.new 才是 camelCase 载荷）
    expect(n.actor_name).toBe(a.handle);
    expect(n.title).toContain(a.handle);
    expect(n.body).toBe("p1.25 hello");
    expect(n.channel_id).toBeTruthy();
    expect(n.message_id).toBeTruthy();
    expect(n.read).toBe(false);

    // 发送方视角：自己的列表里没有 dm 通知（不给自己发）
    const self = await api("/api/notifications", { cookie: a.cookie });
    expect((self.data.notifications as any[]).filter((x) => x.type === "dm")).toHaveLength(0);
  });

  it("unreadOnly 过滤与未读计数", async () => {
    const r = await api("/api/notifications?unreadOnly=true&limit=100", { cookie: b.cookie });
    expect(r.data.notifications.length).toBeGreaterThanOrEqual(1);
    (r.data.notifications as any[]).forEach((n) => {
      expect(n.read).toBe(false);
    });

    const c = await api("/api/notifications/unread-count", { cookie: b.cookie });
    expect(c.data.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it("单条已读：未读数递减；重复标记幂等 200；不存在 404", async () => {
    const before = (await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount;
    const ids = await unreadDmIds(b);
    expect(ids.length).toBeGreaterThanOrEqual(1);

    const mark = await api(`/api/notifications/${ids[0]}/read`, { method: "PATCH", cookie: b.cookie });
    expect(mark.status).toBe(200);
    const after = (await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount;
    expect(before - after).toBe(1);

    // 重复标记：UPDATE 仍命中行 RETURNING 非空 → 200，计数不再变
    const again = await api(`/api/notifications/${ids[0]}/read`, { method: "PATCH", cookie: b.cookie });
    expect(again.status).toBe(200);
    const after2 = (await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount;
    expect(after2).toBe(after);

    expect(
      (await api("/api/notifications/00000000-0000-0000-0000-000000000000/read", { method: "PATCH", cookie: b.cookie }))
        .status,
    ).toBe(404);
  });

  it("批量 ids 已读：精确递减", async () => {
    await sendDm(a, b.handle, "batch-1");
    await sendDm(a, b.handle, "batch-2");
    const before = (await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount;
    const ids = await unreadDmIds(b);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const two = ids.slice(0, 2);

    const r = await api("/api/notifications/read", { method: "PATCH", cookie: b.cookie, body: { ids: two } });
    expect(r.status).toBe(200);
    const after = (await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount;
    expect(before - after).toBe(2);

    const list = (await api("/api/notifications?limit=100", { cookie: b.cookie })).data.notifications as any[];
    for (const id of two) {
      const n = list.find((x) => String(x.id) === id);
      expect(n?.read).toBe(true);
    }
  });

  it("WS：DM 实时推送 notification.new + 单条已读广播 notification.read(ids)", async () => {
    const { ws, next, nextOfType } = connectWs({ Cookie: b.cookie });
    try {
      expect((await next()).type).toBe("connected");

      const sent = await sendDm(a, b.handle, "ws dm push");
      expect(sent.status).toBe(200);
      const newEvt = await nextOfType("notification.new");
      expect(newEvt.notification.type).toBe("dm");
      expect(newEvt.notification.body).toBe("ws dm push");
      const notifId = String(newEvt.notification.id);

      const before = (await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount;
      const mark = await api(`/api/notifications/${notifId}/read`, { method: "PATCH", cookie: b.cookie });
      expect(mark.status).toBe(200);
      const readEvt = await nextOfType("notification.read");
      expect(readEvt.ids).toEqual([notifId]);
      expect(readEvt.all).toBe(false);
      const after = (await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount;
      expect(before - after).toBe(1);
    } finally {
      ws.close();
    }
  });

  it("WS：全部已读广播 notification.read(all=true)", async () => {
    const { ws, next, nextOfType } = connectWs({ Cookie: b.cookie });
    try {
      expect((await next()).type).toBe("connected");
      // 先连接再发 DM：notification.new 推送时套接字必须已存在（否则收不到、超时）
      const sent = await sendDm(a, b.handle, "before mark all");
      expect(sent.status).toBe(200);
      // 消费掉 DM 的 notification.new，再触发全部已读
      await nextOfType("notification.new");

      const r = await api("/api/notifications/read", { method: "PATCH", cookie: b.cookie, body: {} });
      expect(r.status).toBe(200);
      const readEvt = await nextOfType("notification.read");
      expect(readEvt.ids).toBeNull();
      expect(readEvt.all).toBe(true);
      expect((await api("/api/notifications/unread-count", { cookie: b.cookie })).data.unreadCount).toBe(0);
    } finally {
      ws.close();
    }
  });

  it("purgeReadNotifications：只清已读超 30 天，未读与新已读保留", async () => {
    const rows = [
      ["old-read", true, sql`now() - interval '31 days'`],
      ["old-unread", false, sql`now() - interval '31 days'`],
      ["new-read", true, sql`now()`],
    ] as const;
    for (const [title, read, at] of rows) {
      await sql`INSERT INTO notifications (user_id, type, actor_id, title, read, created_at)
        VALUES (${b.userId}::uuid, 'dm', ${a.userId}::uuid, ${title}, ${read}, ${at})`;
    }

    await purgeReadNotifications(fakeApp);

    const kept = await sql<{ title: string }[]>`
      SELECT title FROM notifications WHERE user_id = ${b.userId}::uuid AND title IN ('old-read', 'old-unread', 'new-read')`;
    const titles = kept.map((r) => r.title).sort();
    expect(titles).toEqual(["new-read", "old-unread"]);
  });
});
