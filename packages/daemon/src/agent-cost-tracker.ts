import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * D3 成本记账（Step 4）：按 (agent, channel, day) 累计 stream-json `result`
 * 事件里的成本 / 时长 / 工具轮次。
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
  costUsd?: number | null;
  durationMs?: number | null;
  numTurns?: number | null;
  at?: number;
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

export interface ICostTracker {
  recordTurn(input: CostTurnInput): AgentCostRecord;
  /** D1：Context Builder 注入量（不另开 LLM，计入同 (agent, channel, day)） */
  recordContext(
    agentName: string,
    agentId: string | null,
    channel: string,
    stats: { chars: number; messages: number; dropped: number },
    at?: number,
  ): AgentCostRecord;
  /** 该 agent 当天（UTC）所有频道合计 */
  spendToday(agentName: string, at?: number): number;
  /** 最近 `days` 个 UTC 日（含今天）按 agent 合计 */
  spendByAgent(days?: number, at?: number): CostSpendRow[];
  listRecords(filter?: { agentName?: string; sinceDay?: string; untilDay?: string }): AgentCostRecord[];
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
  ev: any,
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

/** 未设置 / 非正数 → 不熔断（opt-in）。每次调用读 env，便于测试按用例改。 */
export const parseCostBudgetUsd = (raw: string | undefined = process.env.SLOCK_COST_BUDGET_USD): number | null => {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

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
  const budgetUsd = parseCostBudgetUsd();
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

const recordKey = (r: Pick<AgentCostRecord, "agentName" | "channel" | "day">): string =>
  `${r.agentName}\0${r.channel}\0${r.day}`;

export const createJsonCostTracker = (filePath: string, opts?: { now?: () => number }): ICostTracker => {
  const now = opts?.now ?? (() => Date.now());

  const ensureDir = (): void => {
    mkdirSync(dirname(filePath), { recursive: true });
  };

  const readAll = (): StoreFile => {
    if (!existsSync(filePath)) return { records: [] };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return { records: Array.isArray(raw.records) ? raw.records : [] };
    } catch (err: any) {
      console.warn(`[CostTracker] Failed to load ${filePath}: ${err?.message}, starting empty`);
      return { records: [] };
    }
  };

  const writeAll = (data: StoreFile): void => {
    ensureDir();
    const tmp = filePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, filePath);
    } catch (err: any) {
      console.error(`[CostTracker] Atomic write failed: ${err?.message}`);
    }
  };

  const recordTurn = (input: CostTurnInput): AgentCostRecord => {
    const at = input.at ?? now();
    const day = utcDay(at);
    const channel = (input.channel || "unknown").replace(/^#/, "").split(":")[0] || "unknown";
    const data = readAll();
    const key = recordKey({ agentName: input.agentName, channel, day });
    const idx = data.records.findIndex((r) => recordKey(r) === key);
    const addCost = finiteOrZero(input.costUsd);
    const addDur = finiteOrZero(input.durationMs);
    const addTurns = finiteOrZero(input.numTurns);
    if (idx >= 0) {
      const prev = data.records[idx]!;
      const next: AgentCostRecord = {
        ...prev,
        agentId: input.agentId ?? prev.agentId,
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

  const listRecords = (filter?: { agentName?: string; sinceDay?: string; untilDay?: string }): AgentCostRecord[] => {
    return readAll().records.filter((r) => {
      if (filter?.agentName && r.agentName !== filter.agentName) return false;
      if (filter?.sinceDay && r.day < filter.sinceDay) return false;
      if (filter?.untilDay && r.day > filter.untilDay) return false;
      return true;
    });
  };

  const spendToday = (agentName: string, at?: number): number => {
    const day = utcDay(at ?? now());
    return listRecords({ agentName, sinceDay: day, untilDay: day }).reduce((s, r) => s + r.costUsd, 0);
  };

  const spendByAgent = (days = 7, at?: number): CostSpendRow[] => {
    const end = at ?? now();
    const untilDay = utcDay(end);
    const sinceTs = end - (Math.max(1, days) - 1) * 86_400_000;
    const sinceDay = utcDay(sinceTs);
    const map = new Map<string, CostSpendRow>();
    for (const r of listRecords({ sinceDay, untilDay })) {
      const prev = map.get(r.agentName) ?? {
        agentName: r.agentName,
        agentId: r.agentId,
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        turnCount: 0,
        contextChars: 0,
        contextMessages: 0,
        contextDropped: 0,
        contextTurns: 0,
      };
      prev.agentId = r.agentId ?? prev.agentId;
      prev.costUsd += r.costUsd;
      prev.durationMs += r.durationMs;
      prev.numTurns += r.numTurns;
      prev.turnCount += r.turnCount;
      prev.contextChars += r.contextChars ?? 0;
      prev.contextMessages += r.contextMessages ?? 0;
      prev.contextDropped += r.contextDropped ?? 0;
      prev.contextTurns += r.contextTurns ?? 0;
      map.set(r.agentName, prev);
    }
    return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
  };

  const recordContext = (
    agentName: string,
    agentId: string | null,
    channelRaw: string,
    stats: { chars: number; messages: number; dropped: number },
    at?: number,
  ): AgentCostRecord => {
    const ts = at ?? now();
    const day = utcDay(ts);
    const channel = (channelRaw || "unknown").replace(/^#/, "").split(":")[0] || "unknown";
    const data = readAll();
    const key = recordKey({ agentName, channel, day });
    const idx = data.records.findIndex((r) => recordKey(r) === key);
    const addChars = finiteOrZero(stats.chars);
    const addMsgs = finiteOrZero(stats.messages);
    const addDrop = finiteOrZero(stats.dropped);
    if (idx >= 0) {
      const prev = data.records[idx]!;
      const next: AgentCostRecord = {
        ...prev,
        agentId: agentId ?? prev.agentId,
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

  return { recordTurn, recordContext, spendToday, spendByAgent, listRecords };
};
