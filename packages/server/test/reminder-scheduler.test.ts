import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startReminderScheduler } from "../src/lib/reminder-scheduler.js";
import { daemonClients } from "../src/ws/handler.js";
import { closeSql, sql } from "./helpers.js";

// P1.28：reminder-scheduler tick 逻辑（评估零覆盖清单 ④，194 行此前仅手动 E2E）。
// 离线直测（不起 server）：startReminderScheduler(假 app, 100ms) 真实短间隔驱动 tick；
// 数据直插真库（认领 SQL 含 SKIP LOCKED 真事务，纯 mock 打不出）；投递目标 =
// ws/handler 的 daemonClients Map，注入带记录器的假 ws。
//
// 时钟边界说明（报告要求「假时钟」的实现取舍）：scheduler 的到期判定 `fire_at <= now()`
// 是 PG 侧时钟，JS 侧唯一时间输入是消漂移重排的 new Date()——测试对两者的控制都通过
// 「DB 侧插入过去/未来 fire_at」完成（这才是 scheduler 真正服从的时钟）；曾试 vitest
// 假时钟 advanceTimersByTimeAsync 驱动 async tick，其对含真实 IO 的回调不可靠（实测
// tick 未执行），改真实 100ms 间隔 + **轮询到终态**（fire_count ≥1 / 事件行出现），
// 消灭固定 sleep 与「认领事务提交 → 提交后逐行写（重排/事件/通知）」之间的竞态。
//
// 真实 server 进程的 scheduler 不会抢行：P1.23 认领门控要求 agent owner 的 daemon 连在
// 它那边，测试用户从不连 daemon。
//
// 覆盖：无 daemon 跳过 / 一次性 fire+WS 投递+不重排 / every: 消漂移重排（锚定原 fire_at）/
// 离线 owner 不认领（P1.23 门控，行保持 scheduled）/ duty off 不认领 / paused 不认领 /
// patrol 沉默累计+自动暂停+通知+事件 / patrol 有产出清零。

const TAG = "zzsched" + Date.now().toString(36);
let userId = "";
let agentId = "";
let serverId = "";

interface SentFrame {
  type: string;
  [k: string]: unknown;
}
const sentFrames: SentFrame[] = [];

function fakeWs() {
  return {
    bufferedAmount: 0,
    readyState: 1,
    terminate: () => {},
    send: (s: string) => {
      try {
        sentFrames.push(JSON.parse(s));
      } catch {
        /* ignore */
      }
    },
    on: () => {},
  } as any;
}

/** 假 app：pg 用 helpers.sql 真库（事务经 sql.begin 适配出 {rows} 包装，对齐 pgPlugin 形状）；
 * log.error 透传控制台——tick 的 catch 兜底若静音，认领失败会退化成「行永远 scheduled」假象 */
function fakeApp() {
  return {
    pg: {
      transaction: <T>(fn: (tx: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) => Promise<T>) =>
        sql.begin(async (tx) =>
          fn({
            query: async (t: string, p?: unknown[]) => ({ rows: await tx.unsafe(t, (p || []) as any[]) }),
          }),
        ),
      query: async (t: string, p?: unknown[]) => ({ rows: await sql.unsafe(t, (p || []) as any[]) }),
    },
    log: { info: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error("[tick-error]", ...a) },
  } as any;
}

async function insertReminder(overrides: Record<string, unknown>): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO reminders (owner_id, title, fire_at, repeat_rule, status, kind, channel_ref, instructions,
                           consecutive_silent, max_consecutive_silent, paused, last_fired_at)
    VALUES (${agentId}, ${(overrides.title as string) || TAG},
            ${(overrides.fire_at as any) || sql`now() - interval '5 seconds'`},
            ${(overrides.repeat_rule as string) || null}, ${(overrides.status as string) || "scheduled"},
            ${(overrides.kind as string) || "reminder"}, ${(overrides.channel_ref as string) || null},
            ${(overrides.instructions as string) || null},
            ${(overrides.consecutive_silent as number) ?? 0}, ${(overrides.max_consecutive_silent as number) ?? 5},
            ${(overrides.paused as boolean) ?? false}, ${(overrides.last_fired_at as any) || null})
    RETURNING id`;
  return rows[0].id;
}

async function stateOf(id: string): Promise<Record<string, any>> {
  const rows = await sql<Record<string, any>[]>`SELECT * FROM reminders WHERE id = ${id}`;
  return rows[0];
}

/** 起一个 100ms 间隔的真实 scheduler，轮询 until() 为真（或超时）后停掉 */
async function startAndAwait(app: Record<string, any>, until: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const stop = startReminderScheduler(app as any, 100);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (await until()) return;
    }
  } finally {
    stop();
  }
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const claimed = async (id: string) => (await stateOf(id)).fire_count >= 1;

/** 清掉本 agent 名下全部 reminders + 事件（用例间隔离 + afterAll 复用） */
async function cleanupReminders(): Promise<void> {
  await sql`DELETE FROM reminder_events WHERE reminder_id IN (SELECT id FROM reminders WHERE owner_id = ${agentId})`;
  await sql`DELETE FROM reminders WHERE owner_id = ${agentId}`;
}

beforeAll(async () => {
  // 直插用户/server/agent（离线文件，不走 HTTP）；handle 带 zz_test_ 前缀享受通用清理
  const u = await sql<{ id: string }[]>`
    INSERT INTO users (handle, password_hash, email)
    VALUES (${TAG + "_u"}, 'x', ${TAG + "@test.local"})
    RETURNING id`;
  userId = u[0].id;
  const sv = await sql<{ id: string }[]>`
    INSERT INTO servers (name, created_by, owner_id, personal) VALUES (${TAG + "_sv"}, ${userId}, ${userId}, true)
    RETURNING id`;
  serverId = sv[0].id;
  const ag = await sql<{ id: string }[]>`
    INSERT INTO agents (user_id, server_id, name, duty) VALUES (${userId}, ${serverId}, ${TAG + "_a"}, 'on')
    RETURNING id`;
  agentId = ag[0].id;
});

afterEach(async () => {
  daemonClients.delete(userId);
  await cleanupReminders();
});

afterAll(async () => {
  daemonClients.delete(userId);
  await cleanupReminders();
  await sql`DELETE FROM notifications WHERE user_id = ${userId}`;
  // FK 顺序：servers.created_by/owner_id → users，先删 servers 再删 users
  await sql`DELETE FROM agents WHERE id = ${agentId}`;
  await sql`DELETE FROM servers WHERE id = ${serverId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await closeSql();
});

describe("reminder-scheduler tick（真库认领 + 轮询终态）", () => {
  it("无 daemon 连接 → 整轮跳过，到期行不被认领", async () => {
    const id = await insertReminder({ title: TAG + "_nodaemon" });
    // ~600ms 内没有任何认领发生（无 daemon，tick 全部早退）
    await startAndAwait(fakeApp(), async () => false, 600);
    const st = await stateOf(id);
    expect(st.status).toBe("scheduled");
    expect(st.fire_count).toBe(0);
  });

  it("一次性提醒：认领 → fired + reminder.fire 定向投递 + 不重排", async () => {
    daemonClients.set(userId, fakeWs());
    const id = await insertReminder({ title: TAG + "_oneshot" });
    await startAndAwait(fakeApp(), () => claimed(id));

    const st = await stateOf(id);
    expect(st.status).toBe("fired");
    expect(st.fire_count).toBe(1);
    expect(st.last_fired_at).toBeTruthy();

    // WS 定向投递到 owner daemon（假 ws 记录器）；帧在认领事务提交后发出，轮询等待
    expect(
      await waitFor(() => Promise.resolve(sentFrames.some((f) => f.type === "reminder.fire" && f.agentId === agentId))),
    ).toBe(true);
    const fire = sentFrames.find((f) => f.type === "reminder.fire")!;
    expect((fire.reminder as any).title).toBe(TAG + "_oneshot");
    // 一次性（无 repeat_rule）不重排：fired 是终态
    expect(new Date(st.fire_at).getTime()).toBeLessThan(Date.now());
  });

  it("every:1m 周期提醒：fire 后重排 scheduled，锚定原 fire_at + 60s（消漂移）", async () => {
    daemonClients.set(userId, fakeWs());
    const id = await insertReminder({ title: TAG + "_rep", repeat_rule: "every:1m" });
    const before = await stateOf(id);
    const origFireAt = new Date(before.fire_at).getTime();
    await startAndAwait(fakeApp(), () => claimed(id));

    const st = await stateOf(id);
    expect(st.status).toBe("scheduled");
    expect(st.fire_count).toBe(1);
    // 消漂移断言：下一次 = 原定 fire_at + 60s（而非「处理时刻 + 60s」——
    // 若按处理时刻，差值会 ≥ 60s + tick 延迟）
    const next = new Date(st.fire_at).getTime();
    expect(Math.abs(next - (origFireAt + 60_000))).toBeLessThan(2000);
  });

  it("P1.23 认领门控：owner daemon 不在本实例 → 到期行保持 scheduled 不认领", async () => {
    // 不注入 daemonClients（afterEach 已清），只插到期行
    const id = await insertReminder({ title: TAG + "_offline" });
    await startAndAwait(fakeApp(), async () => false, 600);
    const st = await stateOf(id);
    expect(st.status).toBe("scheduled");
    expect(st.fire_count).toBe(0);
  });

  it("duty=off 的 agent 到期行不认领", async () => {
    daemonClients.set(userId, fakeWs());
    await sql`UPDATE agents SET duty = 'off' WHERE id = ${agentId}`;
    try {
      const id = await insertReminder({ title: TAG + "_dutyoff" });
      await startAndAwait(fakeApp(), async () => false, 600);
      const st = await stateOf(id);
      expect(st.status).toBe("scheduled");
      expect(st.fire_count).toBe(0);
    } finally {
      await sql`UPDATE agents SET duty = 'on' WHERE id = ${agentId}`;
    }
  });

  it("paused 行不认领（D3 独立布尔列）", async () => {
    daemonClients.set(userId, fakeWs());
    const id = await insertReminder({ title: TAG + "_paused", paused: true });
    await startAndAwait(fakeApp(), async () => false, 600);
    const st = await stateOf(id);
    expect(st.status).toBe("scheduled");
    expect(st.fire_count).toBe(0);
  });

  it("patrol 沉默：连续无产出累计，达上限自动暂停 + auto_paused 事件 + owner 通知", async () => {
    daemonClients.set(userId, fakeWs());
    const maxSilent = 2;
    const id = await insertReminder({
      title: TAG + "_patrol_silent",
      kind: "patrol",
      repeat_rule: "every:10m",
      channel_ref: `#${TAG}_ch`,
      consecutive_silent: maxSilent - 1, // 上一轮已沉默 1 次，本轮再沉默即达上限
      max_consecutive_silent: maxSilent,
      last_fired_at: new Date(Date.now() - 3600_000),
    });
    await startAndAwait(fakeApp(), () => claimed(id));

    const st = await stateOf(id);
    expect(st.status).toBe("fired");
    expect(st.paused).toBe(true); // 自动暂停
    expect(st.consecutive_silent).toBe(maxSilent);
    // 达上限不重排（停在 fired+paused，等 resume 重排）
    expect(new Date(st.fire_at).getTime()).toBeLessThan(Date.now());

    // 提交后 best-effort 写（事件/通知）轮询等待
    expect(
      await waitFor(async () => {
        const events = await sql<{ event_type: string }[]>`
          SELECT event_type FROM reminder_events WHERE reminder_id = ${id} ORDER BY created_at`;
        const types = events.map((e) => e.event_type);
        return types.includes("fired") && types.includes("auto_paused");
      }),
    ).toBe(true);

    const notif = await sql<{ type: string; title: string }[]>`
      SELECT type, title FROM notifications WHERE user_id = ${userId} AND type = 'patrol_paused'`;
    expect(notif.length).toBe(1);
    expect(notif[0].title).toContain("自动暂停");
  });

  it("patrol 有产出：目标频道内 agent 发过言 → consecutive_silent 清零，不暂停", async () => {
    daemonClients.set(userId, fakeWs());
    // 目标频道 + agent 在 last_fired_at 之后的一条发言
    const ch = await sql<{ id: string }[]>`
      INSERT INTO channels (server_id, name, type) VALUES (${serverId}, ${TAG + "_ch"}, 'public') RETURNING id`;
    const channelId = ch[0].id;
    await sql`
      INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content)
      VALUES (${channelId}, ${serverId}, ${agentId}, 'agent', ${TAG + " patrol posted"})`;
    try {
      const id = await insertReminder({
        title: TAG + "_patrol_posted",
        kind: "patrol",
        repeat_rule: "every:10m",
        channel_ref: `#${TAG}_ch`,
        consecutive_silent: 3,
        last_fired_at: new Date(Date.now() - 3600_000),
      });
      await startAndAwait(fakeApp(), () => claimed(id));

      const st = await stateOf(id);
      expect(st.status).toBe("scheduled"); // 有 repeat → 重排
      expect(st.consecutive_silent).toBe(0); // 产出清零
      expect(st.paused).toBe(false);

      await new Promise((r) => setTimeout(r, 800));
      const events = await sql<{ detail: any }[]>`
        SELECT detail FROM reminder_events WHERE reminder_id = ${id} AND event_type = 'fired'`;
      expect(events.length).toBeGreaterThan(0);
      // postgres.js 对 jsonb 列返回原始字符串（实测），防御性解析
      const detail = typeof events[0].detail === "string" ? JSON.parse(events[0].detail) : events[0].detail;
      expect(detail?.outcome).toBe("posted");
    } finally {
      await sql`DELETE FROM messages WHERE channel_id = ${channelId}`;
      await sql`DELETE FROM channels WHERE id = ${channelId}`;
    }
  });
});
