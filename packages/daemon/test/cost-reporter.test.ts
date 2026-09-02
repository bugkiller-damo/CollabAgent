import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJsonCostTracker, type ICostTracker } from "../src/agent-cost-tracker.js";
import { type CostReporter, createCostReporter } from "../src/cost-reporter.js";

/**
 * P1.24：daemon→server 成本上报。
 *
 * 覆盖：recordTurn/recordContext 标脏 → flushOnce 批量上报「当日累计绝对值」；
 * 成功清脏、失败保脏重试；flush 期间绝对值增长（新回合）不漏报；零值不产生
 * 网络请求；频道归一化与跨天分键；包装 tracker 对聚合查询透明。
 */

const DAY = Date.UTC(2026, 8, 2, 12, 0, 0); // 2026-09-02T12:00:00Z
const DAY2 = DAY + 86_400_000;

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  body: { rows: Array<{ agentName: string; agentId: string | null; channel: string; day: string; costUsd: number }> };
}

describe("cost-reporter (P1.24)", () => {
  let storePath: string;
  let tracker: ICostTracker;
  let reporter: CostReporter;
  let requests: CapturedRequest[];
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    storePath = join(tmpdir(), `slock-cost-reporter-test-${randomUUID()}.json`);
    tracker = createJsonCostTracker(storePath, { now: () => DAY });
    requests = [];
    fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: (init?.headers as Record<string, string>)?.Authorization,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ ok: true, applied: 1, skipped: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    reporter = createCostReporter({
      tracker,
      serverUrl: "http://fake-server.test",
      apiKey: "sk_machine_test",
      intervalMs: 60_000,
      fetchImpl,
    });
  });

  afterEach(async () => {
    await reporter.stop().catch(() => {});
    try {
      rmSync(storePath, { force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(storePath + ".tmp", { force: true });
    } catch {
      /* best-effort */
    }
  });

  const flushOk = (): Promise<{ applied: number; skipped: number } | null> => reporter.flushOnce();

  it("recordTurn 标脏 → flushOnce 上报当日累计绝对值（跨 thread 求和）", async () => {
    reporter.tracker.recordTurn({ agentName: "alice", agentId: "a-1", channel: "#general", costUsd: 0.03, at: DAY });
    reporter.tracker.recordTurn({
      agentName: "alice",
      agentId: "a-1",
      channel: "general",
      threadId: "t8",
      costUsd: 0.02,
      at: DAY,
    });

    const res = await flushOk();
    expect(res).toEqual({ applied: 1, skipped: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://fake-server.test/api/agent-costs/sync");
    expect(requests[0]!.authorization).toBe("Bearer sk_machine_test");
    expect(requests[0]!.body.rows).toEqual([
      { agentName: "alice", agentId: "a-1", channel: "general", day: "2026-09-02", costUsd: 0.05 },
    ]);
  });

  it("成功后清脏；无新数据不再发请求", async () => {
    reporter.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.01, at: DAY });
    expect(await flushOk()).not.toBeNull();
    expect(await flushOk()).toBeNull();
    expect(await flushOk()).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("失败保脏重试；恢复后按当前绝对值上报", async () => {
    let failing = true;
    const swappable = createCostReporter({
      tracker,
      serverUrl: "http://fake-server.test",
      apiKey: "k",
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        if (failing) return new Response("boom", { status: 500 });
        requests.push({ url: String(url), authorization: undefined, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, applied: 1, skipped: 0 }), { status: 200 });
      }) as unknown as typeof fetch,
      log: () => {},
    });
    swappable.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.01, at: DAY });
    expect(await swappable.flushOnce()).toBeNull();
    expect(requests).toHaveLength(0);

    // 恢复前账本又长了一笔 → 重试上报的是最新累计
    swappable.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.04, at: DAY });
    failing = false;
    const res = await swappable.flushOnce();
    expect(res).not.toBeNull();
    expect(requests[0]!.body.rows[0]!.costUsd).toBeCloseTo(0.05, 10);
  });

  it("flush 期间新回合使绝对值增长 → 脏键保留，下轮补报差量", async () => {
    // racing 实例的脏集独立：初始回合必须经 racing.tracker 标脏
    let raced = false;
    const racing = createCostReporter({
      tracker,
      serverUrl: "http://fake-server.test",
      apiKey: "k",
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), authorization: undefined, body: JSON.parse(String(init?.body)) });
        if (!raced) {
          raced = true;
          racing.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.02, at: DAY });
        }
        return new Response(JSON.stringify({ ok: true, applied: 1, skipped: 0 }), { status: 200 });
      }) as unknown as typeof fetch,
      log: () => {},
    });
    racing.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.01, at: DAY });
    await racing.flushOnce();
    expect(requests[0]!.body.rows[0]!.costUsd).toBeCloseTo(0.01, 10);
    // 复检发现值已增长 → 不清脏 → 下轮上报 0.03
    expect(await racing.flushOnce()).not.toBeNull();
    expect(requests[1]!.body.rows[0]!.costUsd).toBeCloseTo(0.03, 10);
    expect(await racing.flushOnce()).toBeNull();
  });

  it("零美元回合（PTY）不产生网络请求，脏键放掉", async () => {
    reporter.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0, at: DAY });
    expect(await flushOk()).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("跨天分键；channel 归一化去 # 与 thread 后缀", async () => {
    reporter.tracker.recordTurn({ agentName: "alice", channel: "#ops:thread1", costUsd: 0.1, at: DAY });
    reporter.tracker.recordTurn({ agentName: "alice", channel: "#ops:thread2", costUsd: 0.2, at: DAY2 });
    await flushOk();
    expect(requests).toHaveLength(1);
    const rows = requests[0]!.body.rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.channel, r.day, r.costUsd])).toEqual(
      expect.arrayContaining([
        ["ops", "2026-09-02", 0.1],
        ["ops", "2026-09-03", 0.2],
      ]),
    );
  });

  it("recordContext 同样标脏（注入量本身零美元，有成本才报）", async () => {
    reporter.tracker.recordContext("alice", "a-1", "dm:@bob", { chars: 100, messages: 3, dropped: 0 });
    expect(await flushOk()).toBeNull();
    expect(requests).toHaveLength(0);

    // 同键后续回合来真金白银 → 一起报出来
    reporter.tracker.recordTurn({ agentName: "alice", channel: "dm:@bob", costUsd: 0.5, at: DAY });
    await flushOk();
    expect(requests[0]!.body.rows[0]!.channel).toBe("dm");
    expect(requests[0]!.body.rows[0]!.costUsd).toBeCloseTo(0.5, 10);
  });

  it("包装 tracker 对聚合查询透明（spendToday/listRecords 直通）", () => {
    reporter.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.07, at: DAY });
    expect(reporter.tracker.spendToday("alice", DAY)).toBeCloseTo(0.07, 10);
    expect(reporter.tracker.listRecords({ agentName: "alice" })).toHaveLength(1);
  });

  it("start/stop：周期到点自动上报，stop 末轮补投且幂等", async () => {
    vi.useFakeTimers();
    try {
      reporter.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.02, at: DAY });
      reporter.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(1);
      reporter.tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.03, at: DAY });
      await reporter.stop();
      expect(requests).toHaveLength(2); // stop 的末轮补投
      await reporter.stop(); // 幂等，不再发
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
