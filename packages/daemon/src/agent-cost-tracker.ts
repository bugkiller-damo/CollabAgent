import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCostBudgetUsd } from "./config.js";
import { errMessage } from "./errors.js";
import { mkdirPrivateSync } from "./private-dir.js";

export { parseCostBudgetUsd } from "./config.js";

/**
 * D3 成本记账（Step 4）：按 (agent, channel, day, thread) 累计 stream-json `result`
 * 事件里的成本 / 时长 / 工具轮次。thread 为空时与历史无 threadId 行兼容。
 *
 * 独立 JSON 文件，不挂在 AgentRunRecord 上——headless 默认路径从不
 * insertAgentRun（那是 PTY spawn 专属），往 runs 上长字段会空转。
 *
 * P0.5（2026-08-25）：Claude Code `result.total_cost_usd` 是**会话累计**
 * （常驻进程内单调不减；CLI `us()` 用进程级 `totalCostUsd` 覆盖 result）。
 * 直接累加会把历史再算一遍，落库前必须对每个常驻进程做「本次 − 上次」。
 * `duration_ms` / `num_turns` 是本回合墙钟 / 本回合工具轮次，按原值累加。
 * one-shot / 首条 result 没有上次基线，差值 = 本次原值。
 *
 * 熔断：SLOCK_COST_BUDGET_USD（每 agent 每个 UTC 日，>0 才生效）超限后
 * A1 队列拒投；频道熔断文案由 daemon-core.postAsAgent 代发（零 LLM）。
 */

export interface AgentCostRecord {
  agentName: string;
  agentId: string | null;
  channel: string;
  /** UTC 日历日 YYYY-MM-DD */
  day: string;
  /** 线程 id；顶层/DM/巡检为空串。旧账本缺字段视为 "" */
  threadId?: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  /** 聚合进本行的 result 事件条数 */
  turnCount: number;
  /** D1：Context Builder 注入累计字符 */
  contextChars?: number;
  /** D1：注入累计保留条数 */
  contextMessages?: number;
  /** D1：超窗丢弃累计条数 */
  contextDropped?: number;
  /** D1：发生过注入的回合数 */
  contextTurns?: number;
  updatedAt: number;
}

export interface CostTurnInput {
  agentName: string;
  agentId?: string | null;
  channel: string;
  /** 可选；不进 channel 字段。空/缺省与旧行（无 threadId）同一把钥匙 */
  threadId?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  numTurns?: number | null;
  at?: number;
}

export interface CostRecordFilter {
  agentName?: string;
  channel?: string;
  threadId?: string;
  sinceDay?: string;
  untilDay?: string;
  /** 若设，覆盖 sinceDay/untilDay 为这一天 */
  day?: string;
}

export interface CostSpendRow {
  agentName: string;
  agentId: string | null;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  turnCount: number;
  contextChars: number;
  contextMessages: number;
  contextDropped: number;
  contextTurns: number;
}

export interface CostChannelSpendRow extends CostSpendRow {
  channel: string;
}

export interface CostDaySpendRow {
  day: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  turnCount: number;
  contextChars: number;
  contextMessages: number;
  contextDropped: number;
  contextTurns: number;
}

export interface ICostTracker {
  recordTurn(input: CostTurnInput): AgentCostRecord;
  /** D1：Context Builder 注入量（不另开 LLM，计入同 (agent, channel, day, thread)） */
  recordContext(
    agentName: string,
    agentId: string | null,
    channel: string,
    stats: { chars: number; messages: number; dropped: number; threadId?: string | null },
    at?: number,
  ): AgentCostRecord;
  /** 该 agent 当天（UTC）所有频道合计 */
  spendToday(agentName: string, at?: number): number;
  /** 最近 `days` 个 UTC 日（含今天）按 agent 合计 */
  spendByAgent(days?: number, at?: number, filter?: CostRecordFilter): CostSpendRow[];
  /** P1.11：按 (channel, agent) 合计 */
  spendByChannel(days?: number, at?: number, filter?: CostRecordFilter): CostChannelSpendRow[];
  /** P1.11：按 UTC 日合计 */
  spendByDay(days?: number, at?: number, filter?: CostRecordFilter): CostDaySpendRow[];
  listRecords(filter?: CostRecordFilter): AgentCostRecord[];
}

interface StoreFile {
  records: AgentCostRecord[];
}

const finiteOrZero = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

const asFiniteNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** stream-json `result` 事件上的累计值；非 result 返回 null。缺字段为 null 而非 0。 */
export const extractResultMetrics = (
  ev: { type?: string; total_cost_usd?: unknown; duration_ms?: unknown; num_turns?: unknown } | null | undefined,
): { costUsd: number | null; durationMs: number | null; numTurns: number | null } | null => {
  if (ev?.type !== "result") return null;
  return {
    costUsd: asFiniteNumber(ev.total_cost_usd),
    durationMs: asFiniteNumber(ev.duration_ms),
    numTurns: asFiniteNumber(ev.num_turns),
  };
};

const clampNonNeg = (v: number): number => (v > 0 ? v : 0);

/**
 * 把会话累计 `total_cost_usd` 换成「本回合增量」。
 *
 * - `costUsd == null`：本回合不记成本，基线也不更新。
 * - 累计回退（新进程 / 计量抖动）：按本次原值记账，并重置基线。
 * - 调用方必须在进程被 stop / reclaim 时 `forget(agentName)`，
 *   否则新进程的首条累计会被当成旧进程的增量而少记。
 *   PersistentClaude 内部换进程（沉默超时）不 forget——回退分支会按原值记账。
 */
export const createSessionCostDelta = (): {
  next: (agentName: string, costUsd: number | null) => number | null;
  forget: (agentName: string) => void;
  peek: (agentName: string) => number | undefined;
} => {
  const last = new Map<string, number>();
  return {
    next(agentName, costUsd) {
      if (costUsd == null) return null;
      const baseline = last.get(agentName) ?? 0;
      const delta = costUsd < baseline ? costUsd : clampNonNeg(costUsd - baseline);
      last.set(agentName, costUsd);
      return delta;
    },
    forget(agentName) {
      last.delete(agentName);
    },
    peek(agentName) {
      return last.get(agentName);
    },
  };
};

export const utcDay = (ts: number = Date.now()): string => new Date(ts).toISOString().slice(0, 10);

export const shouldCircuitBreak = (spendUsd: number, budgetUsd: number | null): boolean =>
  budgetUsd != null && spendUsd >= budgetUsd;

export interface CostGateDecision {
  blocked: boolean;
  spendUsd: number;
  budgetUsd: number | null;
  day: string;
  message: string | null;
}

/** 入队前熔断判定。无 tracker / 未设预算 → 放行。 */
export const evaluateCostGate = (
  tracker: Pick<ICostTracker, "spendToday"> | undefined,
  agentName: string,
  at?: number,
): CostGateDecision => {
  const budgetUsd = parseCostBudgetUsd(); // 每次读 env（测试按用例改 SLOCK_COST_BUDGET_USD）
  const day = utcDay(at);
  const spendUsd = tracker?.spendToday(agentName, at) ?? 0;
  if (!shouldCircuitBreak(spendUsd, budgetUsd) || budgetUsd == null) {
    return { blocked: false, spendUsd, budgetUsd, day, message: null };
  }
  return {
    blocked: true,
    spendUsd,
    budgetUsd,
    day,
    message: buildCircuitBreakMessage(agentName, spendUsd, budgetUsd, day),
  };
};

export const buildCircuitBreakMessage = (agentName: string, spendUsd: number, budgetUsd: number, day: string): string =>
  `⚠️ 成本熔断：@${agentName} 今日（UTC ${day}）花费 $${spendUsd.toFixed(4)} 已达到预算 $${budgetUsd.toFixed(4)}` +
  `（SLOCK_COST_BUDGET_USD）。本 agent 今日不再接收新任务，UTC 次日 00:00 自动恢复。`;

export const defaultCostStorePath = (): string => join(process.cwd(), ".slock", "daemon-costs.json");

/** 频道归一化：去 #、丢掉 thread 后缀。`#general:thread8` → `general`。 */
export const normalizeCostChannel = (raw: string | undefined | null): string =>
  (raw || "unknown").replace(/^#/, "").split(":")[0] || "unknown";

const normalizeThreadId = (raw: string | undefined | null): string => (raw ?? "").trim();

const recordKey = (r: { agentName: string; channel: string; day: string; threadId?: string | null }): string =>
  `${r.agentName}\0${r.channel}\0${r.day}\0${normalizeThreadId(r.threadId)}`;

const emptyMetrics = () => ({
  costUsd: 0,
  durationMs: 0,
  numTurns: 0,
  turnCount: 0,
  contextChars: 0,
  contextMessages: 0,
  contextDropped: 0,
  contextTurns: 0,
});

const addRecordMetrics = <T extends ReturnType<typeof emptyMetrics>>(acc: T, r: AgentCostRecord): T => {
  acc.costUsd += r.costUsd;
  acc.durationMs += r.durationMs;
  acc.numTurns += r.numTurns;
  acc.turnCount += r.turnCount;
  acc.contextChars += r.contextChars ?? 0;
  acc.contextMessages += r.contextMessages ?? 0;
  acc.contextDropped += r.contextDropped ?? 0;
  acc.contextTurns += r.contextTurns ?? 0;
  return acc;
};

const lookbackWindow = (days: number, at: number): { sinceDay: string; untilDay: string } => {
  const untilDay = utcDay(at);
  const sinceTs = at - (Math.max(1, days) - 1) * 86_400_000;
  return { sinceDay: utcDay(sinceTs), untilDay };
};

export const createJsonCostTracker = (filePath: string, opts?: { now?: () => number }): ICostTracker => {
  const now = opts?.now ?? (() => Date.now());

  const ensureDir = (): void => {
    mkdirPrivateSync(dirname(filePath));
  };

  const readAll = (): StoreFile => {
    if (!existsSync(filePath)) return { records: [] };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return { records: Array.isArray(raw.records) ? raw.records : [] };
    } catch (err) {
      console.warn(`[CostTracker] Failed to load ${filePath}: ${errMessage(err)}, starting empty`);
      return { records: [] };
    }
  };

  const writeAll = (data: StoreFile): void => {
    ensureDir();
    const tmp = filePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, filePath);
    } catch (err) {
      console.error(`[CostTracker] Atomic write failed: ${errMessage(err)}`);
    }
  };

  const recordTurn = (input: CostTurnInput): AgentCostRecord => {
    const at = input.at ?? now();
    const day = utcDay(at);
    const channel = normalizeCostChannel(input.channel);
    const threadId = normalizeThreadId(input.threadId);
    const data = readAll();
    const key = recordKey({ agentName: input.agentName, channel, day, threadId });
    const idx = data.records.findIndex((r) => recordKey(r) === key);
    const addCost = finiteOrZero(input.costUsd);
    const addDur = finiteOrZero(input.durationMs);
    const addTurns = finiteOrZero(input.numTurns);
    if (idx >= 0) {
      const prev = data.records[idx]!;
      const next: AgentCostRecord = {
        ...prev,
        agentId: input.agentId ?? prev.agentId,
        threadId: prev.threadId ?? threadId,
        costUsd: prev.costUsd + addCost,
        durationMs: prev.durationMs + addDur,
        numTurns: prev.numTurns + addTurns,
        turnCount: prev.turnCount + 1,
        updatedAt: at,
      };
      data.records[idx] = next;
      writeAll(data);
      return next;
    }
    const created: AgentCostRecord = {
      agentName: input.agentName,
      agentId: input.agentId ?? null,
      channel,
      day,
      threadId,
      costUsd: addCost,
      durationMs: addDur,
      numTurns: addTurns,
      turnCount: 1,
      contextChars: 0,
      contextMessages: 0,
      contextDropped: 0,
      contextTurns: 0,
      updatedAt: at,
    };
    data.records.push(created);
    writeAll(data);
    return created;
  };

  const listRecords = (filter?: CostRecordFilter): AgentCostRecord[] => {
    const sinceDay = filter?.day ?? filter?.sinceDay;
    const untilDay = filter?.day ?? filter?.untilDay;
    const channel = filter?.channel ? normalizeCostChannel(filter.channel) : undefined;
    const threadId = filter?.threadId !== undefined ? normalizeThreadId(filter.threadId) : undefined;
    return readAll().records.filter((r) => {
      if (filter?.agentName && r.agentName !== filter.agentName) return false;
      if (channel && r.channel !== channel) return false;
      if (threadId !== undefined && normalizeThreadId(r.threadId) !== threadId) return false;
      if (sinceDay && r.day < sinceDay) return false;
      if (untilDay && r.day > untilDay) return false;
      return true;
    });
  };

  const spendToday = (agentName: string, at?: number): number => {
    const day = utcDay(at ?? now());
    return listRecords({ agentName, sinceDay: day, untilDay: day }).reduce((s, r) => s + r.costUsd, 0);
  };

  const windowFor = (days: number, at: number | undefined, filter?: CostRecordFilter) =>
    filter?.day ? { sinceDay: filter.day, untilDay: filter.day } : lookbackWindow(days, at ?? now());

  const spendByAgent = (days = 7, at?: number, filter?: CostRecordFilter): CostSpendRow[] => {
    const { sinceDay, untilDay } = windowFor(days, at, filter);
    const map = new Map<string, CostSpendRow>();
    for (const r of listRecords({ ...filter, sinceDay, untilDay })) {
      const prev =
        map.get(r.agentName) ??
        ({ agentName: r.agentName, agentId: r.agentId, ...emptyMetrics() } satisfies CostSpendRow);
      prev.agentId = r.agentId ?? prev.agentId;
      addRecordMetrics(prev, r);
      map.set(r.agentName, prev);
    }
    return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
  };

  const spendByChannel = (days = 7, at?: number, filter?: CostRecordFilter): CostChannelSpendRow[] => {
    const { sinceDay, untilDay } = windowFor(days, at, filter);
    const map = new Map<string, CostChannelSpendRow>();
    for (const r of listRecords({ ...filter, sinceDay, untilDay })) {
      const k = `${r.channel}\0${r.agentName}`;
      const prev =
        map.get(k) ??
        ({
          channel: r.channel,
          agentName: r.agentName,
          agentId: r.agentId,
          ...emptyMetrics(),
        } satisfies CostChannelSpendRow);
      prev.agentId = r.agentId ?? prev.agentId;
      addRecordMetrics(prev, r);
      map.set(k, prev);
    }
    return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd || a.channel.localeCompare(b.channel));
  };

  const spendByDay = (days = 7, at?: number, filter?: CostRecordFilter): CostDaySpendRow[] => {
    const { sinceDay, untilDay } = windowFor(days, at, filter);
    const map = new Map<string, CostDaySpendRow>();
    for (const r of listRecords({ ...filter, sinceDay, untilDay })) {
      const prev = map.get(r.day) ?? ({ day: r.day, ...emptyMetrics() } satisfies CostDaySpendRow);
      addRecordMetrics(prev, r);
      map.set(r.day, prev);
    }
    return Array.from(map.values()).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  };

  const recordContext = (
    agentName: string,
    agentId: string | null,
    channelRaw: string,
    stats: { chars: number; messages: number; dropped: number; threadId?: string | null },
    at?: number,
  ): AgentCostRecord => {
    const ts = at ?? now();
    const day = utcDay(ts);
    const channel = normalizeCostChannel(channelRaw);
    const threadId = normalizeThreadId(stats.threadId);
    const data = readAll();
    const key = recordKey({ agentName, channel, day, threadId });
    const idx = data.records.findIndex((r) => recordKey(r) === key);
    const addChars = finiteOrZero(stats.chars);
    const addMsgs = finiteOrZero(stats.messages);
    const addDrop = finiteOrZero(stats.dropped);
    if (idx >= 0) {
      const prev = data.records[idx]!;
      const next: AgentCostRecord = {
        ...prev,
        agentId: agentId ?? prev.agentId,
        threadId: prev.threadId ?? threadId,
        contextChars: (prev.contextChars ?? 0) + addChars,
        contextMessages: (prev.contextMessages ?? 0) + addMsgs,
        contextDropped: (prev.contextDropped ?? 0) + addDrop,
        contextTurns: (prev.contextTurns ?? 0) + 1,
        updatedAt: ts,
      };
      data.records[idx] = next;
      writeAll(data);
      return next;
    }
    const created: AgentCostRecord = {
      agentName,
      agentId,
      channel,
      day,
      threadId,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      turnCount: 0,
      contextChars: addChars,
      contextMessages: addMsgs,
      contextDropped: addDrop,
      contextTurns: 1,
      updatedAt: ts,
    };
    data.records.push(created);
    writeAll(data);
    return created;
  };

  return { recordTurn, recordContext, spendToday, spendByAgent, spendByChannel, spendByDay, listRecords };
};
