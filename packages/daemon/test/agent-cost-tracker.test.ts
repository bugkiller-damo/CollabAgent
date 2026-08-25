import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCircuitBreakMessage,
  createJsonCostTracker,
  createSessionCostDelta,
  evaluateCostGate,
  extractResultMetrics,
  type ICostTracker,
  parseCostBudgetUsd,
  shouldCircuitBreak,
  utcDay,
} from "../src/agent-cost-tracker.js";

describe("agent-cost-tracker", () => {
  let storePath: string;
  let tracker: ICostTracker;
  const DAY = Date.UTC(2026, 7, 20, 12, 0, 0); // 2026-08-20T12:00:00Z

  beforeEach(() => {
    storePath = join(tmpdir(), `slock-cost-test-${randomUUID()}.json`);
    tracker = createJsonCostTracker(storePath, { now: () => DAY });
    delete process.env.SLOCK_COST_BUDGET_USD;
  });

  afterEach(() => {
    delete process.env.SLOCK_COST_BUDGET_USD;
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

  describe("extractResultMetrics", () => {
    it("pulls numeric cost/duration/turns off a stream-json result event", () => {
      expect(
        extractResultMetrics({
          type: "result",
          subtype: "success",
          total_cost_usd: 0.0123,
          duration_ms: 2300,
          num_turns: 2,
        }),
      ).toEqual({ costUsd: 0.0123, durationMs: 2300, numTurns: 2 });
    });

    it("accepts numeric strings and leaves missing fields null", () => {
      expect(extractResultMetrics({ type: "result", total_cost_usd: "0.5" })).toEqual({
        costUsd: 0.5,
        durationMs: null,
        numTurns: null,
      });
    });

    it("returns null for non-result events", () => {
      expect(extractResultMetrics({ type: "assistant" })).toBeNull();
      expect(extractResultMetrics(null)).toBeNull();
    });
  });

  describe("createSessionCostDelta (P0.5)", () => {
    it("首条 result 没有基线，差值等于本次累计", () => {
      const d = createSessionCostDelta();
      expect(d.next("alice", 0.01)).toBeCloseTo(0.01);
      expect(d.peek("alice")).toBeCloseTo(0.01);
    });

    it("后续 result 只记增量，不把会话累计再加一遍", () => {
      const d = createSessionCostDelta();
      expect(d.next("alice", 0.01)).toBeCloseTo(0.01);
      expect(d.next("alice", 0.03)).toBeCloseTo(0.02);
      expect(d.next("alice", 0.03)).toBe(0);
      expect(d.peek("alice")).toBeCloseTo(0.03);
    });

    it("按 agent 隔离；null 不更新基线", () => {
      const d = createSessionCostDelta();
      expect(d.next("alice", 0.1)).toBeCloseTo(0.1);
      expect(d.next("bob", 0.4)).toBeCloseTo(0.4);
      expect(d.next("alice", null)).toBeNull();
      expect(d.next("alice", 0.15)).toBeCloseTo(0.05);
      expect(d.peek("alice")).toBeCloseTo(0.15);
    });

    it("累计回退（新进程）按本次原值记账并重置基线", () => {
      const d = createSessionCostDelta();
      d.next("alice", 1.5);
      expect(d.next("alice", 0.2)).toBeCloseTo(0.2);
      expect(d.next("alice", 0.5)).toBeCloseTo(0.3);
    });

    it("forget 后下一条按首条处理", () => {
      const d = createSessionCostDelta();
      d.next("alice", 1.0);
      d.forget("alice");
      expect(d.peek("alice")).toBeUndefined();
      expect(d.next("alice", 0.4)).toBeCloseTo(0.4);
    });
  });

  describe("recordTurn + aggregates", () => {
    it("upserts by (agent, channel, day) and sums cost/duration/turns", () => {
      tracker.recordTurn({
        agentName: "alice",
        agentId: "id-a",
        channel: "#general:thread8",
        costUsd: 0.01,
        durationMs: 1000,
        numTurns: 2,
        at: DAY,
      });
      tracker.recordTurn({
        agentName: "alice",
        agentId: "id-a",
        channel: "general",
        costUsd: 0.02,
        durationMs: 500,
        numTurns: 1,
        at: DAY,
      });
      const rows = tracker.listRecords({ agentName: "alice" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.channel).toBe("general");
      expect(rows[0]!.day).toBe("2026-08-20");
      expect(rows[0]!.costUsd).toBeCloseTo(0.03);
      expect(rows[0]!.durationMs).toBe(1500);
      expect(rows[0]!.numTurns).toBe(3);
      expect(rows[0]!.turnCount).toBe(2);
    });

    it("keeps different channels as separate rows; spendToday sums them", () => {
      tracker.recordTurn({ agentName: "alice", channel: "general", costUsd: 0.1, at: DAY });
      tracker.recordTurn({ agentName: "alice", channel: "dm:@bob", costUsd: 0.2, at: DAY });
      expect(tracker.listRecords({ agentName: "alice" })).toHaveLength(2);
      expect(tracker.spendToday("alice", DAY)).toBeCloseTo(0.3);
    });

    it("still increments turnCount when cost fields are missing", () => {
      const row = tracker.recordTurn({ agentName: "alice", channel: "general", at: DAY });
      expect(row.costUsd).toBe(0);
      expect(row.turnCount).toBe(1);
    });

    it("spendByAgent looks back N UTC days inclusive and sorts by spend desc", () => {
      const d0 = DAY;
      const d6 = DAY - 6 * 86_400_000; // 2026-08-14
      const d7 = DAY - 7 * 86_400_000; // 2026-08-13, outside 7-day window
      tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 1, at: d0 });
      tracker.recordTurn({ agentName: "bob", channel: "g", costUsd: 5, at: d6 });
      tracker.recordTurn({ agentName: "carol", channel: "g", costUsd: 99, at: d7 });
      const rows = tracker.spendByAgent(7, DAY);
      expect(rows.map((r) => r.agentName)).toEqual(["bob", "alice"]);
      expect(rows[0]!.costUsd).toBe(5);
      expect(rows.find((r) => r.agentName === "carol")).toBeUndefined();
    });

    it("recordContext accumulates injection stats on the same (agent, channel, day) row", () => {
      tracker.recordTurn({ agentName: "alice", channel: "general", costUsd: 0.1, at: DAY });
      tracker.recordContext("alice", "id-a", "general", { chars: 120, messages: 4, dropped: 2 }, DAY);
      tracker.recordContext("alice", "id-a", "general", { chars: 80, messages: 2, dropped: 0 }, DAY);
      const row = tracker.listRecords({ agentName: "alice" })[0]!;
      expect(row.costUsd).toBeCloseTo(0.1);
      expect(row.contextChars).toBe(200);
      expect(row.contextMessages).toBe(6);
      expect(row.contextDropped).toBe(2);
      expect(row.contextTurns).toBe(2);
      expect(tracker.spendByAgent(7, DAY)[0]!.contextChars).toBe(200);
    });

    it("treats a missing records array (legacy run-store shape) as empty", () => {
      writeFileSync(storePath, JSON.stringify({ runs: [], states: [] }), "utf-8");
      const row = tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.1, at: DAY });
      expect(row.costUsd).toBeCloseTo(0.1);
      const raw = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(Array.isArray(raw.records)).toBe(true);
      expect(raw.records).toHaveLength(1);
    });

    it("treats corrupt JSON as empty and continues", () => {
      writeFileSync(storePath, "{not-json", "utf-8");
      expect(tracker.spendToday("alice", DAY)).toBe(0);
      tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.01, at: DAY });
      expect(tracker.spendToday("alice", DAY)).toBeCloseTo(0.01);
    });
  });

  describe("budget / circuit-break", () => {
    it("parseCostBudgetUsd is opt-in: unset / 0 / negative → null", () => {
      expect(parseCostBudgetUsd(undefined)).toBeNull();
      expect(parseCostBudgetUsd("")).toBeNull();
      expect(parseCostBudgetUsd("0")).toBeNull();
      expect(parseCostBudgetUsd("-1")).toBeNull();
      expect(parseCostBudgetUsd("1.5")).toBe(1.5);
    });

    it("shouldCircuitBreak trips at equality", () => {
      expect(shouldCircuitBreak(1, 1)).toBe(true);
      expect(shouldCircuitBreak(0.99, 1)).toBe(false);
      expect(shouldCircuitBreak(10, null)).toBe(false);
    });

    it("evaluateCostGate blocks when today's spend meets SLOCK_COST_BUDGET_USD", () => {
      process.env.SLOCK_COST_BUDGET_USD = "0.05";
      tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 0.05, at: DAY });
      const gate = evaluateCostGate(tracker, "alice", DAY);
      expect(gate.blocked).toBe(true);
      expect(gate.message).toContain("@alice");
      expect(gate.message).toContain("0.0500");
      expect(gate.day).toBe("2026-08-20");
    });

    it("evaluateCostGate passes when budget unset even with spend", () => {
      tracker.recordTurn({ agentName: "alice", channel: "g", costUsd: 9, at: DAY });
      expect(evaluateCostGate(tracker, "alice", DAY).blocked).toBe(false);
    });

    it("evaluateCostGate passes without a tracker", () => {
      process.env.SLOCK_COST_BUDGET_USD = "0.01";
      expect(evaluateCostGate(undefined, "alice", DAY).blocked).toBe(false);
    });

    it("buildCircuitBreakMessage names the env var and UTC reset", () => {
      const msg = buildCircuitBreakMessage("alice", 1.23456, 1, "2026-08-20");
      expect(msg).toContain("SLOCK_COST_BUDGET_USD");
      expect(msg).toContain("UTC 2026-08-20");
      expect(msg).toContain("$1.2346");
    });
  });

  describe("utcDay", () => {
    it("formats UTC calendar day", () => {
      expect(utcDay(DAY)).toBe("2026-08-20");
    });
  });
});
