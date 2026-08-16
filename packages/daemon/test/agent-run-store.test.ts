import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonRunStore } from "../src/agent-run-store.js";
import type { IAgentRunStore } from "../src/types/index.js";

/**
 * 回归测试：`loadRuntimeState` 之前忽略 agentId，多 agent 场景下会把 A 的
 * 运行时状态（含 lastSessionId）当成 B 的返回；`listActiveAgents` 是
 * autostart 方案 A 的新增查询，调用顺序（必须在 markUnfinishedRunsStale 之前）
 * 直接决定它有没有用——两者都用真实的 createJsonRunStore（不是 mock），
 * 因为这次要验证的正是 JSON 文件读写这一层的行为。
 */
describe("agent-run-store.ts", () => {
  let store: IAgentRunStore;
  let storePath: string;

  beforeEach(() => {
    storePath = join(tmpdir(), `slock-run-store-test-${randomUUID()}.json`);
    store = createJsonRunStore(storePath);
  });

  afterEach(() => {
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

  describe("loadRuntimeState(agentId)", () => {
    it("returns the state for the requested agentId, not just the most-recently-saved one", () => {
      const agentA = randomUUID();
      const agentB = randomUUID();
      store.saveRuntimeState({
        agentId: agentA,
        agentName: "agent-a",
        status: "working",
        lastTransitionAt: 1,
        totalRuns: 3,
        currentRunId: "run-a",
        lastSessionId: "session-a",
        lastSessionUpdatedAt: 1,
      });
      // B 保存得比 A 晚——如果实现退化成"数组最后一条"，查 A 会错误地拿到 B 的数据
      store.saveRuntimeState({
        agentId: agentB,
        agentName: "agent-b",
        status: "idle",
        lastTransitionAt: 2,
        totalRuns: 1,
        currentRunId: null,
        lastSessionId: "session-b",
        lastSessionUpdatedAt: 2,
      });

      expect(store.loadRuntimeState(agentA)?.lastSessionId).toBe("session-a");
      expect(store.loadRuntimeState(agentB)?.lastSessionId).toBe("session-b");
    });

    it("returns null for an agentId that has never been saved", () => {
      expect(store.loadRuntimeState(randomUUID())).toBeNull();
    });

    it("saveRuntimeState overwrites (not appends) the prior state for the same agentId", () => {
      const agentId = randomUUID();
      store.saveRuntimeState({
        agentId,
        agentName: "agent-a",
        status: "working",
        lastTransitionAt: 1,
        totalRuns: 1,
        currentRunId: "run-1",
        lastSessionId: "session-1",
        lastSessionUpdatedAt: 1,
      });
      store.saveRuntimeState({
        agentId,
        agentName: "agent-a",
        status: "idle",
        lastTransitionAt: 2,
        totalRuns: 2,
        currentRunId: null,
        lastSessionId: "session-2",
        lastSessionUpdatedAt: 2,
      });
      const state = store.loadRuntimeState(agentId);
      expect(state?.totalRuns).toBe(2);
      expect(state?.lastSessionId).toBe("session-2");
    });
  });

  describe("listActiveAgents()", () => {
    it("returns only agents with a starting/running run, deduped, and must be called before markUnfinishedRunsStale()", () => {
      const agentA = randomUUID();
      const agentB = randomUUID();
      const agentC = randomUUID();
      // A: 两条 running/starting 记录（同一个 agent 崩溃前连续重启过）——应该只算一次
      store.insertAgentRun({
        runId: "a-1",
        agentId: agentA,
        agentName: "agent-a",
        status: "running",
        exitCode: null,
        startedAt: 1,
        endedAt: null,
        messagesProcessed: 0,
        lastTurnDuration: null,
      });
      store.insertAgentRun({
        runId: "a-2",
        agentId: agentA,
        agentName: "agent-a",
        status: "starting",
        exitCode: null,
        startedAt: 2,
        endedAt: null,
        messagesProcessed: 0,
        lastTurnDuration: null,
      });
      // B: 已经正常退出的记录——不应该出现在 active 列表里
      store.insertAgentRun({
        runId: "b-1",
        agentId: agentB,
        agentName: "agent-b",
        status: "exited",
        exitCode: 0,
        startedAt: 1,
        endedAt: 2,
        messagesProcessed: 1,
        lastTurnDuration: 100,
      });
      // C: 崩溃前正在运行——应该出现
      store.insertAgentRun({
        runId: "c-1",
        agentId: agentC,
        agentName: "agent-c",
        status: "running",
        exitCode: null,
        startedAt: 1,
        endedAt: null,
        messagesProcessed: 0,
        lastTurnDuration: null,
      });

      const active = store.listActiveAgents();
      expect(active.map((a) => a.agentId).sort()).toEqual([agentA, agentC].sort());

      // 调用顺序：markUnfinishedRunsStale() 会把 running/starting 全部改成 error；
      // 之后再调用 listActiveAgents() 必须查到空列表——这正是 daemon-core.ts
      // 里"必须先采集再调用 markUnfinishedRunsStale()"这条约束的意义所在。
      store.markUnfinishedRunsStale();
      expect(store.listActiveAgents()).toEqual([]);
    });

    it("returns an empty list when nothing was starting/running (the common, non-crash case)", () => {
      store.insertAgentRun({
        runId: "x-1",
        agentId: randomUUID(),
        agentName: "agent-x",
        status: "exited",
        exitCode: 0,
        startedAt: 1,
        endedAt: 2,
        messagesProcessed: 1,
        lastTurnDuration: 100,
      });
      expect(store.listActiveAgents()).toEqual([]);
    });
  });
});
