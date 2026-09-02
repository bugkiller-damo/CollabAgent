import { type ICostTracker, normalizeCostChannel, utcDay } from "./agent-cost-tracker.js";
import { errMessage } from "./errors.js";

/**
 * P1.24：daemon→server 成本上报。
 *
 * 评估报告（docs/2026-08-28/01-server-evaluation-report.md §2.5）：
 * daemon 成本记账纯本地 JSON，无上报通道，server/Web 侧成本观测断链
 * （people stats costUsd 恒 null）。本模块把现有 ICostTracker 包装成
 * 「记账照旧 + 标脏 + 定时批量上报」：
 *
 * - **标脏**：recordTurn / recordContext 时记 (agentName, channel, day) 脏键
 *   （与账本 recordKey 同一把归一化：normalizeCostChannel + utcDay）。
 * - **绝对值同步**：上报的不是逐回合增量流，而是脏键在本地账本的**当日累计
 *   绝对值**；server UPSERT 取 GREATEST 单调收敛。选择绝对值而非增量流的
 *   理由：重试 / 乱序 / 进程崩溃后的重放都不会重复计费，也不需要 ack 协议；
 *   账本本身已由 createSessionCostDelta 做过「本次 − 上次」差值（P0.5），
 *   server 存的即增量之和，不是会话累计原值——差值语义在此意义上对齐。
 * - **失败不丢**：flush 失败不清脏键，下个周期重试；flush 期间新产生的回合
 *   会让绝对值超过已上报值，成功后按值复检保留脏键，不漏报。
 * - **零值不报**：PTY 回合记 0 美元（P1.11），全零键不产生网络请求，server
 *   侧也拒收非正数——成本视图只在真金白银出现后才有数据。
 *
 * `SLOCK_COST_REPORT=0` 关闭（daemon-core 不创建 reporter，tracker 原样透传）。
 */

export interface CostReporterOptions {
  /** 本地账本 tracker（原实例，非包装） */
  tracker: ICostTracker;
  serverUrl: string;
  /** 机器令牌（sk_machine_，daemon 账号级凭证，与 postAsAgent 同源） */
  apiKey: string;
  /** 上报周期，默认 60s */
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface CostReporter {
  /** 包装后的 tracker：记账行为与原实例一致，额外标脏。传给 runtime 用这个 */
  tracker: ICostTracker;
  start(): void;
  /** 停表并 best-effort 补投一次（调用方自行加超时兜底） */
  stop(): Promise<void>;
  /** 立即上报一轮；无脏键 / 已在报 / 失败返回 null，成功返回 server 计数 */
  flushOnce(): Promise<{ applied: number; skipped: number } | null>;
}

interface SyncRow {
  agentName: string;
  agentId: string | null;
  channel: string;
  day: string;
  costUsd: number;
}

const dirtyKey = (agentName: string, channel: string, day: string): string => `${agentName}\0${channel}\0${day}`;

export const createCostReporter = (opts: CostReporterOptions): CostReporter => {
  const tracker = opts.tracker;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const intervalMs = opts.intervalMs ?? 60_000;
  const log = opts.log ?? ((msg: string) => console.warn(msg));

  const dirty = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let flushing = false;

  const markDirty = (agentName: string, channelRaw: string, at?: number): void => {
    dirty.add(dirtyKey(agentName, normalizeCostChannel(channelRaw), utcDay(at)));
  };

  const wrapped: ICostTracker = {
    recordTurn(input) {
      try {
        markDirty(input.agentName, input.channel, input.at);
      } catch {
        /* 标脏失败不影响本地记账 */
      }
      return tracker.recordTurn(input);
    },
    recordContext(agentName, agentId, channelRaw, stats, at) {
      try {
        markDirty(agentName, channelRaw, at);
      } catch {
        /* 标脏失败不影响本地记账 */
      }
      return tracker.recordContext(agentName, agentId, channelRaw, stats, at);
    },
    spendToday: (agentName, at) => tracker.spendToday(agentName, at),
    spendByAgent: (days, at, filter) => tracker.spendByAgent(days, at, filter),
    spendByChannel: (days, at, filter) => tracker.spendByChannel(days, at, filter),
    spendByDay: (days, at, filter) => tracker.spendByDay(days, at, filter),
    listRecords: (filter) => tracker.listRecords(filter),
  };

  /** 读脏键在账本的当日累计绝对值（跨 thread 行求和）；无行 / 全零返回 null */
  const absoluteFor = (agentName: string, channel: string, day: string): SyncRow | null => {
    const rows = tracker.listRecords({ agentName, channel, sinceDay: day, untilDay: day });
    let costUsd = 0;
    let agentId: string | null = null;
    for (const r of rows) {
      costUsd += r.costUsd;
      agentId = r.agentId ?? agentId;
    }
    if (!rows.length || !(costUsd > 0)) return null;
    return { agentName, agentId, channel, day, costUsd };
  };

  const flushOnce = async (): Promise<{ applied: number; skipped: number } | null> => {
    if (flushing || dirty.size === 0) return null;
    flushing = true;
    try {
      const keys = Array.from(dirty);
      const rows: SyncRow[] = [];
      for (const key of keys) {
        const [agentName, channel, day] = key.split("\0");
        const row = absoluteFor(agentName!, channel!, day!);
        if (row) rows.push(row);
      }
      if (rows.length === 0) {
        // 全零 / 账本已清——无事可报，直接放掉脏键（后续回合会重新标脏）
        for (const key of keys) dirty.delete(key);
        return null;
      }
      const res = await fetchImpl(new URL("/api/agent-costs/sync", opts.serverUrl).toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      if (!res.ok) throw new Error(`cost sync HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { applied?: number; skipped?: number };
      // 成功后按值复检：flush 期间又跑出更大绝对值的键保留到下轮，不漏报
      for (const row of rows) {
        const key = dirtyKey(row.agentName, row.channel, row.day);
        const nowRow = absoluteFor(row.agentName, row.channel, row.day);
        if (!nowRow || nowRow.costUsd <= row.costUsd) dirty.delete(key);
      }
      return { applied: body.applied ?? 0, skipped: body.skipped ?? 0 };
    } catch (err) {
      log(`[Daemon] cost report failed (will retry next tick): ${errMessage(err)}`);
      return null;
    } finally {
      flushing = false;
    }
  };

  return {
    tracker: wrapped,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void flushOnce();
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await flushOnce();
    },
    flushOnce,
  };
};
