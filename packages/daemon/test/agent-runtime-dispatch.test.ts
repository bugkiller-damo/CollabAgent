import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0.8：agent-runtime-dispatch 核心编排单测。
 *
 * 覆盖评估报告点名的四个面：
 * - runAgent / runAgentDm / runAgentReminder / runAgentTriage 的 prompt 路由
 * - doDispatch（headless）：懒 spawn + 复用、reminder tail、成本差值落库
 * - 成本熔断：入队门 / drain 门 / doDispatch 兜底门、每日去重通知
 * - 回复守卫：代发 / 追问一次不循环 / 进度条改写分支 / 开关关闭
 *
 * PersistentClaude 用 vi.mock 换成可控假进程（不启真实 claude）；
 * mcp-bundle mock 掉避免 esbuild 打包；context builder mock 成可断言行。
 */

// ---- vi.mock 的工厂被提升，假类必须经 vi.hoisted 暴露 ----
const { FakePersistentClaude, claudePrintMock, claudePrintImpl, fetchDispatchContextMock } = vi.hoisted(() => {
  class FakePersistentClaude {
    static instances: FakePersistentClaude[] = [];
    static reset(): void {
      FakePersistentClaude.instances = [];
      FakePersistentClaude.defaultSendImpl = undefined;
    }
    opts: any;
    sent: string[] = [];
    stopped = false;
    /** 测试注入的 send 行为；缺省立即 resolve（不触发回合边界） */
    sendImpl?: (text: string, self: FakePersistentClaude) => Promise<void>;
    constructor(opts: any) {
      this.opts = opts;
      FakePersistentClaude.instances.push(this);
    }
    static defaultSendImpl?: (text: string, self: FakePersistentClaude) => Promise<void>;
    send(text: string): Promise<void> {
      this.sent.push(text);
      const impl = this.sendImpl ?? FakePersistentClaude.defaultSendImpl;
      return impl ? impl(text, this) : Promise.resolve();
    }
    /** 测试辅助：模拟一条 stream-json 事件到达 */
    emit(ev: any): void {
      this.opts.onStreamEvent?.(ev);
    }
    stop(): void {
      this.stopped = true;
    }
  }
  const claudePrintImpl = async (...args: any[]) => {
    const onStreamEvent = args[5];
    if (typeof onStreamEvent === "function") {
      onStreamEvent({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.07,
        duration_ms: 11,
        num_turns: 1,
      });
    }
    return { reply: "ok", sessionId: "sess-1" };
  };
  const claudePrintMock = vi.fn(claudePrintImpl);
  const fetchDispatchContextMock = vi.fn(async () => null as import("../src/agent-startup.js").DispatchContext | null);
  return { FakePersistentClaude, claudePrintMock, claudePrintImpl, fetchDispatchContextMock };
});

vi.mock("../src/drivers/persistent-claude.js", () => ({ PersistentClaude: FakePersistentClaude }));
vi.mock("../src/claude-print.js", () => ({ claudePrint: claudePrintMock }));
vi.mock("../src/mcp-bundle.js", () => ({ bundleSlockMcpServer: async () => null }));
vi.mock("../src/agent-context-builder.js", () => ({
  buildThreadContextEnvelope: vi.fn(async () => null),
  buildChannelContextEnvelope: vi.fn(async () => null),
}));
// A1.3：dispatchHeadlessTurn 每回合会调 fetchDispatchContext 查频道经理/worker；
// 其余 agent-startup 行为（真实写 sysprompt/工作区文件）保持真实实现。
vi.mock("../src/agent-startup.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/agent-startup.js")>();
  return { ...actual, fetchDispatchContext: fetchDispatchContextMock };
});

import { buildChannelContextEnvelope, buildThreadContextEnvelope } from "../src/agent-context-builder.js";
import { createObservationBus } from "../src/agent-observation.js";
import { createDispatch, type DispatchDeps, type IDispatch } from "../src/agent-runtime-dispatch.js";
import {
  type AgentRuntimeDriver,
  type AgentRuntimeOpenOptions,
  AgentRuntimeRegistry,
  type AgentRuntimeSession,
  type AgentRuntimeTurnResult,
  type AgentTurnRequest,
} from "../src/agent-runtime-driver.js";
import type { AgentRuntimeEvent } from "../src/agent-runtime-events.js";
import { createRuntimeInterruptStore } from "../src/agent-runtime-interrupt-store.js";
import type { ResolvedAgentRuntimeProfile } from "../src/agent-runtime-profile.js";
import { createAgentStateMachine, type IAgentStateMachine } from "../src/agent-runtime-state.js";
import { createTurnTracker } from "../src/agent-runtime-turn-tracker.js";
import { createClaudeRuntimeDriver } from "../src/drivers/claude-runtime.js";
import { DispatchError, type DispatchErrorCode } from "../src/errors.js";
import { createIdleReclaimer } from "../src/idle-reclaimer.js";
import { slockDir } from "../src/private-dir.js";

const AGENT = "zz_disp_agent";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const AGENT2 = "zz_disp_other";
const AGENT2_ID = "22222222-2222-2222-2222-222222222222";

const flush = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeTracker {
  spend: number;
  recordTurn: ReturnType<typeof vi.fn>;
  recordContext: ReturnType<typeof vi.fn>;
  spendToday: (name: string) => number;
  spendByAgent: () => never[];
  listRecords: () => never[];
}

const makeTracker = (): FakeTracker => ({
  spend: 0,
  recordTurn: vi.fn(),
  recordContext: vi.fn(),
  spendToday(name: string) {
    return name === AGENT || name === AGENT2 ? this.spend : 0;
  },
  spendByAgent: () => [],
  listRecords: () => [],
});

interface Harness {
  deps: DispatchDeps;
  dispatch: IDispatch;
  stateMachine: IAgentStateMachine;
  tracker: FakeTracker;
  onReplyMissing: ReturnType<typeof vi.fn>;
  onCircuitBreak: ReturnType<typeof vi.fn>;
  onDeliveryQueued: ReturnType<typeof vi.fn>;
  onDeliveryDeadLetter: ReturnType<typeof vi.fn>;
  onProgress: ReturnType<typeof vi.fn>;
  mintAgentCredential: ReturnType<typeof vi.fn>;
  abortAgentProcess: ReturnType<typeof vi.fn>;
}

/** 发一条「有 send_message 动作」的完整回合事件流，回合结束状态机回 idle。 */
const emitTurnWithSend = (inst: InstanceType<typeof FakePersistentClaude>, costUsd = 0.01): void => {
  inst.emit({
    type: "assistant",
    message: {
      id: "msg-1",
      content: [
        { type: "text", text: "好的，我来处理" },
        {
          type: "tool_use",
          name: "mcp__slock__send_message",
          id: "tu-1",
          input: { target: "#general", content: "回复" },
        },
      ],
    },
  });
  inst.emit({ type: "result", subtype: "success", total_cost_usd: costUsd, duration_ms: 100, num_turns: 1 });
};

const makeHarness = (overrides?: {
  tracker?: FakeTracker;
  resolveAgentId?: (name: string) => string | null;
  createProgressPoster?: DispatchDeps["createProgressPoster"];
  agentSessionStore?: DispatchDeps["agentSessionStore"];
  usePty?: boolean;
  resolveRuntimeProfile?: DispatchDeps["resolveRuntimeProfile"];
  sessionIdentities?: DispatchDeps["sessionIdentities"];
  runtimeRegistry?: DispatchDeps["runtimeRegistry"];
  interruptStore?: DispatchDeps["interruptStore"];
}): Harness => {
  const stateMachine = createAgentStateMachine();
  stateMachine.transitionState(AGENT, "idle");
  stateMachine.transitionState(AGENT2, "idle");
  const tracker = overrides?.tracker ?? makeTracker();
  const onReplyMissing = vi.fn();
  const onCircuitBreak = vi.fn();
  const onDeliveryQueued = vi.fn();
  const onDeliveryDeadLetter = vi.fn();
  const onProgress = vi.fn();
  const mintAgentCredential = vi.fn(async () => "sk_agent_test_token");
  const abortAgentProcess = vi.fn();

  const deps: DispatchDeps = {
    options: { serverUrl: "http://fake-server.test", apiKey: "test-key" },
    stateMachine,
    turnTracker: createTurnTracker(),
    exitChain: {
      registerRunContext: vi.fn(),
      incrementMessagesProcessed: vi.fn(),
      onExit: vi.fn(),
      preSpawn: vi.fn(),
      register: vi.fn(),
    },
    idleReclaimer: createIdleReclaimer({ timeoutMs: Number.MAX_SAFE_INTEGER, onReclaim: () => {} }),
    credentialsClient: { mintAgentCredential, revokeAgentCredential: vi.fn(async () => {}) },
    postStartWriter: (async () => {}) as any,
    spawnPtyForAgent: vi.fn() as any,
    usePty: overrides?.usePty ?? false,
    resolveAgentId: overrides?.resolveAgentId ?? ((n) => (n === AGENT ? AGENT_ID : n === AGENT2 ? AGENT2_ID : null)),
    agentInfo: new Map(),
    runIdByAgent: new Map(),
    // Phase 0/1：headless 会话经 registry→driver 边界创建；Fake 仍被 vi.mock
    // 拦截，inst.emit 的原始 stream-json 事件照常过 normalizer（适配器边界被测到）。
    runtimeRegistry: overrides?.runtimeRegistry ?? new AgentRuntimeRegistry([createClaudeRuntimeDriver()]),
    resolveRuntimeProfile: overrides?.resolveRuntimeProfile,
    sessionIdentities: overrides?.sessionIdentities,
    interruptStore: overrides?.interruptStore,
    persistentSessions: new Map(),
    agentSessions: new Map(),
    agentSessionStore: overrides?.agentSessionStore,
    observationBus: createObservationBus(),
    costTracker: tracker as any,
    onReplyMissing,
    onCircuitBreak,
    onDeliveryQueued,
    onDeliveryDeadLetter,
    onProgress,
    createProgressPoster: overrides?.createProgressPoster,
    abortAgentProcess,
  };
  const dispatch = createDispatch(deps);
  return {
    deps,
    dispatch,
    stateMachine,
    tracker,
    onReplyMissing,
    onCircuitBreak,
    onDeliveryQueued,
    onDeliveryDeadLetter,
    onProgress,
    mintAgentCredential,
    abortAgentProcess,
  };
};

const cleanupWorkspace = (name: string): void => {
  try {
    rmSync(join(slockDir(), `sysprompt-${name}.md`), { force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(join(slockDir(), "workspaces", name), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
};

describe("agent-runtime-dispatch (headless)", () => {
  let harness: Harness;

  beforeEach(() => {
    FakePersistentClaude.reset();
    vi.mocked(buildThreadContextEnvelope).mockReset().mockResolvedValue(null);
    vi.mocked(buildChannelContextEnvelope).mockReset().mockResolvedValue(null);
    delete process.env.SLOCK_COST_BUDGET_USD;
    delete process.env.SLOCK_DISPATCH_MAX_RETRIES;
    delete process.env.SLOCK_REPLY_GUARD;
    delete process.env.SLOCK_CHANNEL_PROGRESS;
    delete process.env.SLOCK_ONESHOT_CLAUDE;
    claudePrintMock.mockReset();
    claudePrintMock.mockImplementation(claudePrintImpl);
    fetchDispatchContextMock.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    harness?.dispatch.disposeQueue();
    cleanupWorkspace(AGENT);
    cleanupWorkspace(AGENT2);
    delete process.env.SLOCK_COST_BUDGET_USD;
    delete process.env.SLOCK_DISPATCH_MAX_RETRIES;
    delete process.env.SLOCK_REPLY_GUARD;
    delete process.env.SLOCK_ONESHOT_CLAUDE;
    vi.restoreAllMocks();
  });

  describe("doDispatch 基础链路", () => {
    it("首条消息懒启动 PersistentClaude 并复用；reminder tail 追加一次", async () => {
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hello");

      expect(FakePersistentClaude.instances).toHaveLength(1);
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent).toHaveLength(1);
      expect(inst.sent[0]).toContain("hello");
      expect(inst.sent[0]).toContain("<slock-reminder>");
      expect(inst.sent[0]).toContain(`@${AGENT}`);
      expect(harness.mintAgentCredential).toHaveBeenCalledWith(AGENT_ID);
      // send 已 resolve 但无 result 事件 → 回合未结束，状态停留 working
      expect(harness.stateMachine.getState(AGENT)).toBe("working");

      emitTurnWithSend(inst);
      await flush();
      expect(harness.stateMachine.getState(AGENT)).toBe("idle");

      inst.sendImpl = async (_t, self) => emitTurnWithSend(self);
      await harness.dispatch.dispatchToAgent(AGENT, "general", "again");
      expect(FakePersistentClaude.instances).toHaveLength(1); // 复用同一进程
      expect(inst.sent).toHaveLength(2);
      expect(inst.sent[1]).toContain("again");
      await flush();
      expect(harness.stateMachine.getState(AGENT)).toBe("idle");
    });

    it("result 事件的会话累计成本按差值落库（P0.5）", async () => {
      process.env.SLOCK_REPLY_GUARD = "0"; // 关掉守卫，避免无发送回合触发追问干扰计数
      harness = makeHarness();

      await harness.dispatch.dispatchToAgent(AGENT, "general", "turn-1");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.05, duration_ms: 10, num_turns: 1 });
      await flush();

      await harness.dispatch.dispatchToAgent(AGENT, "general", "turn-2");
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.08, duration_ms: 20, num_turns: 2 });
      await flush();

      expect(harness.tracker.recordTurn).toHaveBeenCalledTimes(2);
      expect(harness.tracker.recordTurn.mock.calls[0][0]).toMatchObject({
        agentName: AGENT,
        channel: "general",
        costUsd: 0.05,
      });
      // 0.08 - 0.05：会话累计的差值，而非 0.08 全量再记一次
      expect(harness.tracker.recordTurn.mock.calls[1][0].costUsd).toBeCloseTo(0.03, 10);
      expect(harness.tracker.recordTurn.mock.calls[1][0]).toMatchObject({ durationMs: 20, numTurns: 2 });
    });

    it("result 事件把 turnGuard.threadId 一并落库（P1.11）", async () => {
      process.env.SLOCK_REPLY_GUARD = "0";
      harness = makeHarness();

      await harness.dispatch.runAgent(AGENT, "general", "#general:t8", "bob", "追问", "t8");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.04, duration_ms: 9, num_turns: 1 });
      await flush();

      expect(harness.tracker.recordTurn).toHaveBeenCalledTimes(1);
      expect(harness.tracker.recordTurn.mock.calls[0][0]).toMatchObject({
        agentName: AGENT,
        channel: "general",
        threadId: "t8",
        costUsd: 0.04,
      });
    });

    it("forgetSessionCost 清基线：新进程首条累计按原值记账（P0.5）", async () => {
      process.env.SLOCK_REPLY_GUARD = "0";
      harness = makeHarness();

      await harness.dispatch.dispatchToAgent(AGENT, "general", "turn-1");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.05 });
      await flush();

      harness.dispatch.forgetSessionCost(AGENT);
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.02 });
      await flush();

      // 基线已清：0.02 按原值记（若没清会被当成 0.02-0.05 的回退/负增量）
      expect(harness.tracker.recordTurn.mock.calls[1][0].costUsd).toBeCloseTo(0.02, 10);
    });

    it("send 失败：状态机回 idle，重试耗尽进死信（maxRetries=1）", async () => {
      process.env.SLOCK_DISPATCH_MAX_RETRIES = "1"; // 必须早于 createDispatch
      harness = makeHarness();

      await harness.dispatch.dispatchToAgent(AGENT, "general", "warm-up");
      const inst = FakePersistentClaude.instances[0]!;

      inst.sendImpl = async () => {
        throw new Error("process died mid-turn");
      };
      await harness.dispatch.dispatchToAgent(AGENT, "general", "boom-msg");
      await flush(30);

      expect(harness.onDeliveryDeadLetter).toHaveBeenCalledTimes(1);
      const [name, channel, err] = harness.onDeliveryDeadLetter.mock.calls[0];
      expect(name).toBe(AGENT);
      expect(channel).toBe("general");
      expect(String((err as Error)?.message ?? err)).toContain("process died mid-turn");
      expect(harness.stateMachine.getState(AGENT)).toBe("idle");
      // P1.12：失败实例必须 stop 并从 map 摘掉，避免下一条 send 打到死会话
      expect(inst.stopped).toBe(true);
      expect(harness.deps.persistentSessions.has(AGENT)).toBe(false);
    });

    it("P1.12：send 首次即失败也踢会话；下一条换新实例", async () => {
      process.env.SLOCK_DISPATCH_MAX_RETRIES = "1";
      process.env.SLOCK_REPLY_GUARD = "0";
      FakePersistentClaude.defaultSendImpl = async () => {
        throw new Error("process died mid-turn");
      };
      harness = makeHarness();

      await harness.dispatch.dispatchToAgent(AGENT, "general", "boom-first");
      await flush(30);

      expect(harness.onDeliveryDeadLetter).toHaveBeenCalledTimes(1);
      expect(FakePersistentClaude.instances).toHaveLength(1);
      expect(FakePersistentClaude.instances[0]!.stopped).toBe(true);
      expect(harness.deps.persistentSessions.has(AGENT)).toBe(false);

      FakePersistentClaude.defaultSendImpl = undefined;
      await harness.dispatch.dispatchToAgent(AGENT, "general", "after-boom");
      expect(FakePersistentClaude.instances).toHaveLength(2);
      expect(harness.deps.persistentSessions.get(AGENT)).toBe(FakePersistentClaude.instances[1]);
      expect(FakePersistentClaude.instances[1]!.sent[0]).toContain("after-boom");
    });

    it("A2：system init 的 session_id 落进 agentSessionStore（spawn --resume 数据源）", async () => {
      const SID = "67f1f0e9-aaaa-4bbb-8ccc-dddddddddddd";
      const store = {
        remember: vi.fn(() => null),
        lookup: vi.fn(() => null),
        forget: vi.fn(() => false),
        list: vi.fn(() => []),
      };
      harness = makeHarness({ agentSessionStore: store });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hello");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "system", subtype: "init", session_id: SID });
      expect(store.remember).toHaveBeenCalledWith(AGENT, SID);
    });

    it("无 agentId 的 agent 入队即死信，不 spawn", async () => {
      harness = makeHarness({ resolveAgentId: () => null });
      await harness.dispatch.dispatchToAgent("ghost", "general", "hi");
      expect(harness.onDeliveryDeadLetter).toHaveBeenCalledTimes(1);
      expect(String(harness.onDeliveryDeadLetter.mock.calls[0][2])).toContain("not deliverable");
      expect(FakePersistentClaude.instances).toHaveLength(0);
    });

    it("忙碌时积压合并为一条复合 prompt（tail 只追加一次）并提示已缓冲", async () => {
      process.env.SLOCK_REPLY_GUARD = "0"; // 本测试不关心守卫
      harness = makeHarness();

      await harness.dispatch.dispatchToAgent(AGENT, "general", "m1");
      // 等队列 .finally 把 draining 置回 false（settleDone 在 .then、draining=false 在
      // .finally，await done 的续跑夹在两者之间）——否则下一条会被误判 busy 进积压。
      await flush(5);
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent).toHaveLength(1);

      // m2 挂住（模拟长回合），m3/m4 积压在队列
      let releaseM2!: () => void;
      inst.sendImpl = async () => {
        await new Promise<void>((r) => (releaseM2 = r));
        inst.sendImpl = async () => {}; // 后续立即完成
      };
      const p2 = harness.dispatch.dispatchToAgent(AGENT, "general", "m2");
      const p3 = harness.dispatch.dispatchToAgent(AGENT, "general", "m3");
      const p4 = harness.dispatch.dispatchToAgent(AGENT, "general", "m4");
      await flush(5);
      expect(harness.onDeliveryQueued).toHaveBeenCalled();

      releaseM2();
      await Promise.all([p2, p3, p4]);
      await flush();

      expect(inst.sent).toHaveLength(3); // m1, m2, m3+m4 合并
      expect(inst.sent[2]).toContain("m3");
      expect(inst.sent[2]).toContain("m4");
      expect(inst.sent[2].indexOf("m3")).toBeLessThan(inst.sent[2].indexOf("m4"));
      expect((inst.sent[2].match(/<slock-reminder>/g) ?? []).length).toBe(1);
    });

    it("dedup：窗口内同内容入队被吞", async () => {
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "same-content");
      const inst = FakePersistentClaude.instances[0]!;
      await harness.dispatch.dispatchToAgent(AGENT, "general", "same-content");
      await flush();
      expect(inst.sent).toHaveLength(1);
    });

    it("one-shot 路径把 stream-json result 记入成本（P1.11）", async () => {
      process.env.SLOCK_ONESHOT_CLAUDE = "1";
      process.env.SLOCK_REPLY_GUARD = "0";
      harness = makeHarness();

      await harness.dispatch.dispatchToAgent(AGENT, "general", "oneshot-cost");
      await flush();

      expect(FakePersistentClaude.instances).toHaveLength(0);
      expect(claudePrintMock).toHaveBeenCalled();
      expect(typeof claudePrintMock.mock.calls[0][5]).toBe("function");
      expect(harness.tracker.recordTurn).toHaveBeenCalledTimes(1);
      expect(harness.tracker.recordTurn.mock.calls[0][0]).toMatchObject({
        agentName: AGENT,
        channel: "general",
        costUsd: 0.07,
        durationMs: 11,
        numTurns: 1,
      });
    });

    it("A1.1：agentInfo.model 传进 PersistentClaude opts（headless 不再无视所选模型）", async () => {
      harness = makeHarness();
      harness.deps.agentInfo.set(AGENT, { model: "haiku" });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hello");
      expect(FakePersistentClaude.instances[0]!.opts.model).toBe("haiku");
    });

    it("A1.3：经理 dispatchContext 进回合语境行（含可派发名单）", async () => {
      fetchDispatchContextMock.mockResolvedValue({ isManager: true, otherAgents: ["worker-a"] });
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "派个活");
      const sent = FakePersistentClaude.instances[0]!.sent[0]!;
      expect(sent).toContain("派个活");
      expect(sent).toContain("【本回合语境】");
      expect(sent).toContain("经理");
      expect(sent).toContain("@worker-a");
    });
  });

  describe("成本熔断（D3 / P0.6）", () => {
    it("入队门：超预算直接拒投并通知频道，同日去重", async () => {
      const tracker = makeTracker();
      tracker.spend = 2;
      process.env.SLOCK_COST_BUDGET_USD = "1";
      harness = makeHarness({ tracker });

      await harness.dispatch.dispatchToAgent(AGENT, "general", "blocked-1");
      await harness.dispatch.dispatchToAgent(AGENT, "general", "blocked-2");
      await flush();

      expect(FakePersistentClaude.instances).toHaveLength(0);
      expect(harness.onCircuitBreak).toHaveBeenCalledTimes(1); // 每 agent 每日一次
      expect(harness.onCircuitBreak.mock.calls[0][0]).toBe(AGENT);
      expect(harness.onCircuitBreak.mock.calls[0][1]).toBe("general");
      expect(harness.onCircuitBreak.mock.calls[0][2]).toContain("成本熔断");
    });

    it("drain 门：入队时未超预算、排空时已熔断的积压被拦下丢弃（P0.6）", async () => {
      const tracker = makeTracker();
      harness = makeHarness({ tracker });

      // 第一条正常完成
      await harness.dispatch.dispatchToAgent(AGENT, "general", "first");
      const inst = FakePersistentClaude.instances[0]!;
      emitTurnWithSend(inst);
      await flush();

      // 第二条挂住（长回合），第三条积压——此刻都还没超预算
      let releaseM2!: () => void;
      inst.sendImpl = async () => {
        await new Promise<void>((r) => (releaseM2 = r));
      };
      const p2 = harness.dispatch.dispatchToAgent(AGENT, "general", "second");
      const p3 = harness.dispatch.dispatchToAgent(AGENT, "general", "third");
      await flush(5);
      expect(inst.sent).toHaveLength(2);

      // 预算在积压期间耗尽
      process.env.SLOCK_COST_BUDGET_USD = "1";
      tracker.spend = 5;

      emitTurnWithSend(inst); // second 的回合边界
      releaseM2();
      await p2;
      await p3; // 被 drain 门拦下：settle 完结但不投递
      await flush();

      expect(inst.sent).toHaveLength(2); // third 从未送达
      expect(harness.onCircuitBreak).toHaveBeenCalledTimes(1);
      expect(harness.onDeliveryDeadLetter).not.toHaveBeenCalled(); // 熔断丢弃 ≠ 死信
    });
  });

  describe("回复守卫（reply guard）", () => {
    it("回合无发送动作但有正文 → onReplyMissing 代发最后正文", async () => {
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "问题");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "这是答案" }] } });
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.01 });
      await flush(30);

      expect(harness.onReplyMissing).toHaveBeenCalledTimes(1);
      expect(harness.onReplyMissing).toHaveBeenCalledWith(AGENT, "general", "这是答案");
      expect(inst.sent).toHaveLength(1); // 代发而非追问
    });

    it("回合无发送动作且无正文 → 追问一次；追问回合不再触发守卫（不循环）", async () => {
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "问题");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.01 });
      await flush(50); // 等追问走完队列

      expect(inst.sent).toHaveLength(2);
      expect(inst.sent[1]).toContain("[slock-reply-guard]");
      expect(inst.sent[1]).toContain('target="general"');
      expect(harness.onReplyMissing).not.toHaveBeenCalled();

      // 追问回合同样无输出结束 → isNudge，守卫不再触发
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.02 });
      await flush(50);
      expect(inst.sent).toHaveLength(2);
      expect(harness.onReplyMissing).not.toHaveBeenCalled();
    });

    it("进度条已改写为最终答复 → 不再代发（rewritten 分支）", async () => {
      const edit = vi.fn(async () => true);
      harness = makeHarness({
        createProgressPoster: () => ({
          post: async () => "progress-msg-1",
          edit,
          remove: async () => true,
        }),
      });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "问题");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "改写成答案" }] } });
      // 真实时序：text 帧与 result 事件之间有真实时间间隔，note() 的 flush 微任务
      // 在此期间完成 post；若同步连发，finish 先置 closed，排队中的 flush 会跳过
      // post（messageId 空 → rewritten 恒 false）。这里让出事件循环模拟真实间隔。
      await flush(5);
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.01 });
      await flush(30);

      expect(edit).toHaveBeenCalledWith("progress-msg-1", "改写成答案");
      expect(harness.onReplyMissing).not.toHaveBeenCalled();
    });

    it("SLOCK_REPLY_GUARD=0 时既不代发也不追问", async () => {
      process.env.SLOCK_REPLY_GUARD = "0";
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "问题");
      const inst = FakePersistentClaude.instances[0]!;
      inst.emit({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "答案" }] } });
      inst.emit({ type: "result", subtype: "success", total_cost_usd: 0.01 });
      await flush(50);

      expect(harness.onReplyMissing).not.toHaveBeenCalled();
      expect(inst.sent).toHaveLength(1);
    });

    it("有 send_message 动作的回合不触发守卫", async () => {
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "问题");
      emitTurnWithSend(FakePersistentClaude.instances[0]!);
      await flush(50);
      expect(harness.onReplyMissing).not.toHaveBeenCalled();
      expect(FakePersistentClaude.instances[0]!.sent).toHaveLength(1);
    });
  });

  describe("runAgent / DM / reminder / triage 路由", () => {
    it("runAgent 带 threadId：注入线程上下文信封 + 线程语义文案（D1）", async () => {
      harness = makeHarness();
      vi.mocked(buildThreadContextEnvelope).mockResolvedValue({
        envelope: "<<ctx-envelope>>",
        chars: 16,
        kept: 2,
        dropped: 1,
        threadId: "thread-1",
      } as any);

      await harness.dispatch.runAgent(AGENT, "general", "#general:thread-1", "bob", "问题内容", "thread-1", "msg-9");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("<<ctx-envelope>>");
      expect(inst.sent[0]).toContain("的一个线程里被 @ 了");
      expect(inst.sent[0]).toContain("问题内容");
      expect(inst.sent[0]).toContain('target="#general:thread-1"');
      expect(buildThreadContextEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: AGENT_ID,
          channelName: "general",
          threadId: "thread-1",
          triggerId: "msg-9",
        }),
      );
      expect(harness.tracker.recordContext).toHaveBeenCalledWith(AGENT, AGENT_ID, "general", {
        chars: 16,
        messages: 2,
        dropped: 1,
        threadId: "thread-1",
      });
    });

    it("runAgent 无线程：拉顶层小预算历史（A3/§8.6），返回 null 时退回裸 prompt", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgent(AGENT, "general", "#general", "bob", "顶层问题");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("#general 频道被 @ 了");
      expect(inst.sent[0]).not.toContain("<<ctx-envelope>>");
      expect(buildThreadContextEnvelope).not.toHaveBeenCalled();
      // 顶层 @ 现在走频道小预算上下文（DM 走 dm:@x 同路径）
      expect(buildChannelContextEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: AGENT_ID,
          channelName: "general",
          triggerContent: "顶层问题",
        }),
      );
      expect(harness.tracker.recordContext).not.toHaveBeenCalled(); // null → 不记账
    });

    it("runAgent 无线程：顶层信封注入 prompt 并记 context 账（A3/§8.6）", async () => {
      harness = makeHarness();
      vi.mocked(buildChannelContextEnvelope).mockResolvedValue({
        envelope: "<<chan-ctx>>",
        chars: 12,
        kept: 3,
        dropped: 1,
      } as any);

      await harness.dispatch.runAgent(AGENT, "general", "#general", "bob", "顶层问题", undefined, "msg-7");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("<<chan-ctx>>");
      expect(inst.sent[0]).toContain("顶层问题");
      expect(inst.sent[0].indexOf("<<chan-ctx>>")).toBeLessThan(inst.sent[0].indexOf("顶层问题"));
      expect(buildChannelContextEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ channelName: "general", triggerId: "msg-7" }),
      );
      expect(buildThreadContextEnvelope).not.toHaveBeenCalled();
      expect(harness.tracker.recordContext).toHaveBeenCalledWith(AGENT, AGENT_ID, "general", {
        chars: 12,
        messages: 3,
        dropped: 1,
        threadId: undefined,
      });
    });

    it("context builder 返回 null 时退回裸 prompt（不失忆也不阻断）", async () => {
      harness = makeHarness(); // 默认 mockResolvedValue(null)
      await harness.dispatch.runAgent(AGENT, "general", "#general:t1", "bob", "问题", "t1");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("问题");
      expect(inst.sent[0]).not.toContain("<<ctx-envelope>>");
      expect(harness.tracker.recordContext).not.toHaveBeenCalled();
    });

    it("runAgentDm：私信 prompt 与 dm 回执 target；注入 dm 小预算上下文（A3/§8.6）", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgentDm(AGENT, "dm:@bob", "bob", "在吗");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("私信（DM）");
      expect(inst.sent[0]).toContain('target="dm:@bob"');
      // DM 走同一个小预算上下文路径，channel 参数传 "dm:@bob" 目标
      expect(buildChannelContextEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: AGENT_ID, channelName: "dm:@bob", triggerContent: "在吗" }),
      );
      expect(buildThreadContextEnvelope).not.toHaveBeenCalled();
    });

    it("runAgentReminder patrol：巡检模板，频道取 # 后 : 前", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgentReminder(AGENT, {
        title: "日检",
        channel: "#ops:threadX",
        kind: "patrol",
        instructions: "检查日志",
      });
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("【定时巡检】日检");
      expect(inst.sent[0]).toContain("检查日志");
      expect(inst.sent[0]).toContain("#ops:threadX");
    });

    it("runAgentReminder 普通提醒：无频道默认 general", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgentReminder(AGENT, { title: "喝水" });
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("⏰");
      expect(inst.sent[0]).toContain("喝水");
    });

    it("runAgentTriage：分诊模板；nudge 不注顶层上下文", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgentTriage(AGENT, "general", "#general", "bob", "谁能看下这个");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("【频道分诊】#general");
      expect(inst.sent[0]).toContain("@bob");
      expect(inst.sent[0]).toContain("dispatch_task");
      // 分诊是 nudge 性质：topLevel=false，不拉顶层小预算历史
      expect(buildChannelContextEnvelope).not.toHaveBeenCalled();
    });
  });

  describe("Phase 1：runtime profile 解析与身份失效", () => {
    const profileOf = (over: Partial<ResolvedAgentRuntimeProfile> = {}): ResolvedAgentRuntimeProfile => ({
      runtime: "claude",
      identity: "id-claude",
      ...over,
    });
    const profileError = (runtime: string, code: DispatchErrorCode): ResolvedAgentRuntimeProfile =>
      profileOf({ runtime, identity: `err-${code}`, error: { code, message: code } });

    it("legacy 无 runtime 字段 → 走 claude，行为不变", async () => {
      harness = makeHarness();
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hello");
      expect(FakePersistentClaude.instances).toHaveLength(1);
      expect(harness.onDeliveryDeadLetter).not.toHaveBeenCalled();
    });

    it("bridge 无 entrypoint → entrypoint-required 首次失败即死信（不 spawn）", async () => {
      harness = makeHarness({
        resolveRuntimeProfile: () => profileError("bridge", "entrypoint-required"),
      });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
      await flush();
      expect(harness.onDeliveryDeadLetter).toHaveBeenCalledTimes(1);
      const err = harness.onDeliveryDeadLetter.mock.calls[0][2] as DispatchError;
      expect(err).toBeInstanceOf(DispatchError);
      expect(err.code).toBe("entrypoint-required");
      expect(err.retriable).toBe(false);
      expect(FakePersistentClaude.instances).toHaveLength(0);
    });

    it("默认解析器读 agentInfo：bridge 缺 entrypoint → entrypoint-required（旧别名 langgraph 归一同码）", async () => {
      harness = makeHarness();
      harness.deps.agentInfo.set(AGENT, { runtime: "bridge" });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
      await flush();
      const err = harness.onDeliveryDeadLetter.mock.calls[0][2] as DispatchError;
      expect(err.code).toBe("entrypoint-required");
      expect(FakePersistentClaude.instances).toHaveLength(0);
    });

    it("WP6：agentInfo 给旧别名 langgraph → 归一 bridge → 缺 entrypoint 同码死信", async () => {
      harness = makeHarness();
      harness.deps.agentInfo.set(AGENT, { runtime: "langgraph" });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
      await flush();
      expect((harness.onDeliveryDeadLetter.mock.calls[0][2] as DispatchError).code).toBe("entrypoint-required");
    });

    it("claude + entrypoint → entrypoint-not-allowed 死信", async () => {
      harness = makeHarness();
      harness.deps.agentInfo.set(AGENT, { runtime: "claude", entrypoint: "ep-1" });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
      await flush();
      expect((harness.onDeliveryDeadLetter.mock.calls[0][2] as DispatchError).code).toBe("entrypoint-not-allowed");
    });

    it("profile 上游冲突 → runtime-profile-conflict 直通死信", async () => {
      harness = makeHarness({
        resolveRuntimeProfile: () => profileError("claude", "runtime-profile-conflict"),
      });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
      await flush();
      expect((harness.onDeliveryDeadLetter.mock.calls[0][2] as DispatchError).code).toBe("runtime-profile-conflict");
    });

    it("未注册 runtime（codex）→ runtime-unsupported 死信", async () => {
      harness = makeHarness({ resolveRuntimeProfile: () => profileOf({ runtime: "codex", identity: "id-codex" }) });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
      await flush();
      const err = harness.onDeliveryDeadLetter.mock.calls[0][2] as DispatchError;
      expect(err).toBeInstanceOf(DispatchError);
      expect(err.code).toBe("runtime-unsupported");
      expect(FakePersistentClaude.instances).toHaveLength(0);
    });

    it("usePty + 非 claude runtime → pty-runtime-unsupported（冻结层不接新 runtime）", async () => {
      harness = makeHarness({
        usePty: true,
        resolveRuntimeProfile: () => profileOf({ runtime: "bridge", identity: "id-lg", entrypoint: "ep-1" }),
      });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
      await flush();
      const err = harness.onDeliveryDeadLetter.mock.calls[0][2] as DispatchError;
      expect(err).toBeInstanceOf(DispatchError);
      expect(err.code).toBe("pty-runtime-unsupported");
      expect(err.retriable).toBe(false);
    });

    it("model 变更 → 旧常驻会话被丢弃并按新身份重开", async () => {
      process.env.SLOCK_REPLY_GUARD = "0";
      harness = makeHarness();
      harness.deps.agentInfo.set(AGENT, { model: "sonnet" });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "first");
      const inst1 = FakePersistentClaude.instances[0]!;
      emitTurnWithSend(inst1);
      await flush();

      harness.deps.agentInfo.set(AGENT, { model: "sonnet" });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "same-model");
      expect(FakePersistentClaude.instances).toHaveLength(1); // 同 identity → 复用

      harness.deps.agentInfo.set(AGENT, { model: "haiku" });
      emitTurnWithSend(inst1); // 让上一回合收尾
      await harness.dispatch.dispatchToAgent(AGENT, "general", "new-model");
      await flush();
      expect(inst1.stopped).toBe(true); // identity 变了 → 旧会话被踢
      expect(FakePersistentClaude.instances).toHaveLength(2);
      expect(harness.deps.persistentSessions.get(AGENT)).toBe(FakePersistentClaude.instances[1]);
      expect(FakePersistentClaude.instances[1]!.opts.model).toBe("haiku");
    });
  });

  describe("Phase 2：回合元数据 / interrupt 续接（§8.4/§11）", () => {
    /** 捕获 openSession 选项与 send(request) 的假 bridge driver——验证 dispatch→driver 边界载荷 */
    class FakeBridgeSession implements AgentRuntimeSession {
      alive = true;
      requests: AgentTurnRequest[] = [];
      stopped = false;
      /** 测试注入的回合结果；send 前先经 onEvent 发 turn.end（模仿真 worker 顺序） */
      result: AgentRuntimeTurnResult = { status: "success", finalText: "done" };
      endEvent: AgentRuntimeEvent = {
        type: "turn.end",
        status: "success",
        result: "done",
        usage: { costUsd: null, durationMs: 12, numTurns: 1, inputTokens: 10, outputTokens: 5 },
      };
      constructor(public opts: AgentRuntimeOpenOptions) {}
      // biome-ignore lint/suspicious/noConfusingVoidType: 与 AgentRuntimeSession 契约一致（void = 仅事件结算）
      send(req: AgentTurnRequest): Promise<void | AgentRuntimeTurnResult> {
        this.requests.push(req);
        this.opts.onEvent(this.endEvent);
        return Promise.resolve(this.result);
      }
      stop(): void {
        this.stopped = true;
        this.alive = false;
      }
    }

    const makeBridgeRegistry = () => {
      const sessions: FakeBridgeSession[] = [];
      const driver: AgentRuntimeDriver = {
        driverId: "fake-bridge",
        runtimeIds: ["bridge"],
        openSession: (o) => {
          const s = new FakeBridgeSession(o);
          sessions.push(s);
          return s;
        },
        forgetAgent: vi.fn(),
      };
      return {
        sessions,
        registry: new AgentRuntimeRegistry([createClaudeRuntimeDriver(), driver]),
      };
    };

    const bridgeProfile: ResolvedAgentRuntimeProfile = {
      runtime: "bridge",
      model: "gpt-test",
      entrypoint: "ep-graph",
      identity: "id-bridge",
    };

    it("bridge profile → registry 解析对应 driver，turn 元数据完整进 AgentTurnRequest", async () => {
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
      });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi there", undefined, undefined, undefined, "alice");
      await flush();

      expect(sessions).toHaveLength(1);
      const sess = sessions[0]!;
      // openSession 边界：manifest entrypoint + resolved model + initialize 素材
      expect(sess.opts.entrypoint).toBe("ep-graph");
      expect(sess.opts.model).toBe("gpt-test");
      expect(sess.opts.mode).toBe("persistent");
      expect(sess.opts.agent?.id).toBe(AGENT_ID);
      expect(sess.opts.agent?.name).toBe(AGENT);
      // bridge 的平台提示走 initialize 文本（mcp-bundle 在本测试 mock 成 null → 无 mcp 描述符）
      expect(sess.opts.platformPrompt).toContain(AGENT);
      expect(sess.opts.mcp).toBeUndefined();

      expect(sess.requests).toHaveLength(1);
      const req = sess.requests[0]!;
      expect(req.turnId).toMatch(/^turn-/);
      expect(req.conversationId).toBe(`slock:v1:${AGENT_ID}:channel:general`);
      expect(req.attempt).toBe(1);
      expect(req.prompt).toContain("hi there");
      expect(req.source).toEqual({ kind: "message", channel: "general", sender: "alice" });
      expect(req.resume).toBeUndefined();
      expect(harness.onDeliveryDeadLetter).not.toHaveBeenCalled();
    });

    it("threadId / reminder sourceId 参与 §11.1 conversationId 分类", async () => {
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
      });
      await harness.dispatch.dispatchToAgent(AGENT, "general", "thread msg", "t-1");
      await harness.dispatch.dispatchToAgent(AGENT, "general", "remind", undefined, "reminder", "rem-9");
      await flush();

      expect(sessions).toHaveLength(1);
      const reqs = sessions[0]!.requests;
      expect(reqs[0]!.conversationId).toBe(`slock:v1:${AGENT_ID}:thread:t-1`);
      expect(reqs[0]!.source.threadId).toBe("t-1");
      expect(reqs[1]!.conversationId).toBe(`slock:v1:${AGENT_ID}:reminder:rem-9`);
      expect(reqs[1]!.source.kind).toBe("reminder");
    });

    it("interrupted → 写 pending；同 conversation 下一条带 resume；success 后删除", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: store,
      });
      try {
        const sess0p = async () => sessions[0]!;
        // 第一回合：worker 中断 → pending interrupt 落盘
        await harness.dispatch.dispatchToAgent(AGENT, "general", "hit approval wall");
        const sess = await sess0p();
        sess.result = {
          status: "interrupted",
          interrupt: { interruptId: "int-1", resumeToken: "tok-abc", prompt: "批准执行吗？" },
        };
        sess.endEvent = {
          type: "turn.end",
          status: "interrupted",
          usage: { costUsd: null, durationMs: 5, numTurns: 1 },
          interrupt: { interruptId: "int-1", resumeToken: "tok-abc", prompt: "批准执行吗？" },
        };
        // send 已 resolve 于第一次 dispatch 前——重发一条触发 interrupted 结果
        await harness.dispatch.dispatchToAgent(AGENT, "general", "still waiting");
        await flush();
        expect(sess.requests).toHaveLength(2);
        const pending = store.list();
        expect(pending).toHaveLength(1);
        expect(pending[0]!.resumeToken).toBe("tok-abc");
        expect(pending[0]!.conversationId).toBe(`slock:v1:${AGENT_ID}:channel:general`);

        // 第二回合（resume）：下一条消息携带 resumeToken；success 后 pending 清除
        sess.result = { status: "success", finalText: "resumed" };
        sess.endEvent = {
          type: "turn.end",
          status: "success",
          result: "resumed",
          usage: { costUsd: null, durationMs: 8, numTurns: 1 },
        };
        await harness.dispatch.dispatchToAgent(AGENT, "general", "批准，继续");
        await flush();
        expect(sess.requests).toHaveLength(3);
        const resumed = sess.requests[2]!;
        expect(resumed.resume).toEqual({ interruptId: "int-1", resumeToken: "tok-abc", value: "批准，继续" });
        expect(resumed.resume?.value).toContain("批准");
        expect(store.list()).toHaveLength(0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("WP11：turnResult cancelled = 正常回合收口——不重试不死信，队列后续消息继续派发同一会话", async () => {
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
      });
      // 第一回合：send resolve cancelled（worker 对 turn.cancel 回 cancelled 终态）。
      // turn.end.usage 在 AgentRuntimeEvent 契约里必填（driver 恒发规范化对象），
      // fake 终态帧必须带上——缺了会让观察帧映射抛 TypeError，整条 send reject。
      await harness.dispatch.dispatchToAgent(AGENT, "general", "hi", undefined, undefined, undefined, "alice");
      const sess = sessions[0]!;
      sess.result = { status: "cancelled" };
      sess.endEvent = {
        type: "turn.end",
        status: "cancelled",
        usage: { costUsd: null, durationMs: 6, numTurns: 1 },
      };
      await harness.dispatch.dispatchToAgent(AGENT, "general", "stop it");
      await flush();

      // cancelled 终态走完成功路径：该项不再重试（send 仍只调了 1 次该回合）、无死信
      expect(sess.requests).toHaveLength(2);
      expect(sess.requests[1]!.attempt).toBe(1);
      expect(harness.onDeliveryDeadLetter).not.toHaveBeenCalled();

      // 队列后续消息照常投递到同一常驻会话（worker 未被取消杀）
      sess.result = { status: "success", finalText: "done" };
      sess.endEvent = {
        type: "turn.end",
        status: "success",
        result: "done",
        usage: { costUsd: null, durationMs: 8, numTurns: 1 },
      };
      await harness.dispatch.dispatchToAgent(AGENT, "general", "next question");
      await flush();
      expect(sessions).toHaveLength(1);
      expect(sess.requests).toHaveLength(3);
      expect(sess.requests[2]!.prompt).toContain("next question");
      expect(harness.onDeliveryDeadLetter).not.toHaveBeenCalled();
    });

    // ---- WP10：interrupt:resolve 结构化恢复（审批面按钮 → resume.decision） ----

    const putPending = (
      store: ReturnType<typeof createRuntimeInterruptStore>,
      over?: Partial<Parameters<typeof store.put>[0]>,
    ) =>
      store.put({
        agentId: AGENT_ID,
        agentName: AGENT,
        channel: "general",
        threadId: "t-9",
        runtime: "bridge",
        entrypoint: "ep-graph",
        conversationId: `slock:v1:${AGENT_ID}:thread:t-9`,
        interruptId: "int-77",
        resumeToken: "tok-77",
        prompt: "批准执行危险操作？",
        options: { decisions: ["approve", "reject", "respond", "edit"] },
        kind: "message",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        ...over,
      });

    it("resolve 回合：pending 身份锁定 + resume.decision 原样 + approver 进 source.sender", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: store,
      });
      try {
        const conv = `slock:v1:${AGENT_ID}:thread:t-9`;
        putPending(store);
        // 模拟 runtime.resolveInterrupt 的入队形态：content=决定可读文本、
        // sender=approver、resolve 锁定 (conversationId, interruptId, decision)
        await harness.dispatch.dispatchToAgent(
          AGENT,
          "general",
          "【审批】批准",
          "t-9",
          "message",
          undefined,
          "alice-h",
          undefined,
          undefined,
          { conversationId: conv, interruptId: "int-77", decision: { type: "approve" } },
        );
        await flush();

        expect(sessions).toHaveLength(1);
        const req = sessions[0]!.requests[0]!;
        expect(req.conversationId).toBe(conv); // 锁定 pending 的 conversationId，不派生
        expect(req.prompt).toBe("【审批】批准"); // 决定可读文本（bridge 无 reminder tail）
        expect(req.resume).toEqual({
          interruptId: "int-77",
          resumeToken: "tok-77",
          value: "【审批】批准",
          decision: { type: "approve" },
        });
        expect(req.source).toMatchObject({ kind: "message", channel: "general", threadId: "t-9", sender: "alice-h" });
        // success 终态 → pending 按 §11.4 消耗
        expect(store.list()).toHaveLength(0);
        expect(harness.onDeliveryDeadLetter).not.toHaveBeenCalled();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("reject/respond/edit 的可读 resume.value 与 decision 直通", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: store,
      });
      try {
        const conv = `slock:v1:${AGENT_ID}:thread:t-9`;
        const cases: Array<{ text: string; decision: any; value: string }> = [
          {
            text: "【审批】拒绝：先补测试",
            decision: { type: "reject", message: "先补测试" },
            value: "【审批】拒绝：先补测试",
          },
          {
            text: "【审批】回复：用 GET 就行",
            decision: { type: "respond", message: "用 GET 就行" },
            value: "【审批】回复：用 GET 就行",
          },
          {
            text: '【审批】修改参数：{"file":"a.ts"}',
            decision: { type: "edit", args: { file: "a.ts" } },
            value: '【审批】修改参数：{"file":"a.ts"}',
          },
        ];
        const sess = () => sessions[0]!;
        for (const [idx, c] of cases.entries()) {
          putPending(store, { interruptId: `int-${idx}`, resumeToken: `tok-${idx}` });
          await harness.dispatch.dispatchToAgent(
            AGENT,
            "general",
            c.text,
            "t-9",
            "message",
            undefined,
            "alice-h",
            undefined,
            undefined,
            { conversationId: conv, interruptId: `int-${idx}`, decision: c.decision },
          );
          await flush();
          const req = sess().requests.at(-1)!;
          expect(req.resume).toEqual({
            interruptId: `int-${idx}`,
            resumeToken: `tok-${idx}`,
            value: c.value,
            decision: c.decision,
          });
          expect(store.list()).toHaveLength(0); // 每轮 success 消耗后再放下一条
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("interruptId 不符（pending 被顶替）→ 不派发、不删记录、推快照；非投递错误", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: store,
      });
      const onInterruptsChange = vi.fn();
      harness.deps.options.onInterruptsChange = onInterruptsChange;
      try {
        const conv = `slock:v1:${AGENT_ID}:thread:t-9`;
        putPending(store, { interruptId: "int-NEW" }); // 同会话被新 interrupt 顶替
        await harness.dispatch.dispatchToAgent(
          AGENT,
          "general",
          "【审批】批准",
          "t-9",
          "message",
          undefined,
          "alice-h",
          undefined,
          undefined,
          { conversationId: conv, interruptId: "int-OLD", decision: { type: "approve" } },
        );
        await flush();
        expect(sessions).toHaveLength(0); // turn.start 从未发出
        expect(store.list().map((r) => r.interruptId)).toEqual(["int-NEW"]); // 顶替记录原样保留
        expect(onInterruptsChange).toHaveBeenCalled();
        expect(harness.onDeliveryDeadLetter).not.toHaveBeenCalled(); // 陈旧恢复不是投递错误
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("options.decisions 未声明该决定 → 不派发、记录保留", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: store,
      });
      try {
        const conv = `slock:v1:${AGENT_ID}:thread:t-9`;
        putPending(store, { options: { decisions: ["reject"] } }); // 只声明 reject
        await harness.dispatch.dispatchToAgent(
          AGENT,
          "general",
          "【审批】批准",
          "t-9",
          "message",
          undefined,
          "alice-h",
          undefined,
          undefined,
          { conversationId: conv, interruptId: "int-77", decision: { type: "approve" } },
        );
        await flush();
        expect(sessions).toHaveLength(0);
        expect(store.list()).toHaveLength(1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("pending 已消失（dismiss/过期被清）→ 静默丢弃不发回合", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: store,
      });
      const onInterruptsChange = vi.fn();
      harness.deps.options.onInterruptsChange = onInterruptsChange;
      try {
        const conv = `slock:v1:${AGENT_ID}:thread:t-9`;
        putPending(store, { expiresAt: Date.now() - 1 }); // 已过期——take 惰性清除返回 null
        await harness.dispatch.dispatchToAgent(
          AGENT,
          "general",
          "【审批】批准",
          "t-9",
          "message",
          undefined,
          "alice-h",
          undefined,
          undefined,
          { conversationId: conv, interruptId: "int-77", decision: { type: "approve" } },
        );
        await flush();
        expect(sessions).toHaveLength(0);
        expect(store.list()).toHaveLength(0); // take 已惰性清掉过期记录
        expect(onInterruptsChange).toHaveBeenCalled();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("resolve 不与积压消息合并——锁定身份单独成回合", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      const { registry, sessions } = makeBridgeRegistry();
      harness = makeHarness({
        runtimeRegistry: registry,
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: store,
      });
      try {
        const conv = `slock:v1:${AGENT_ID}:thread:t-9`;
        putPending(store);
        // resolve 消耗 pending（success 终态删记录）→ 紧随其后的同会话
        // 普通消息开全新回合（resume 缺省）——两个独立 turn.start。
        // （队列层的硬边界/不合并语义由 agent-dispatch-queue.test.ts 覆盖）
        await harness.dispatch.dispatchToAgent(
          AGENT,
          "general",
          "【审批】批准",
          "t-9",
          "message",
          undefined,
          "alice-h",
          undefined,
          undefined,
          { conversationId: conv, interruptId: "int-77", decision: { type: "approve" } },
        );
        await harness.dispatch.dispatchToAgent(AGENT, "general", "追问一句", "t-9");
        await flush();
        const reqs = sessions[0]!.requests;
        expect(reqs).toHaveLength(2);
        expect(reqs[0]!.resume?.decision).toEqual({ type: "approve" });
        expect(reqs[1]!.resume).toBeUndefined();
        expect(reqs[1]!.prompt).toContain("追问一句");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("WP2：bridge 回合 prompt 走 neutral 模板（无 Claude 约定 / 无 reminder tail）", () => {
    /** 与 Phase 2 同型的假 bridge driver——本 describe 自包含（作用域隔离） */
    class FakeBridgeSession implements AgentRuntimeSession {
      alive = true;
      requests: AgentTurnRequest[] = [];
      stopped = false;
      endEvent: AgentRuntimeEvent = {
        type: "turn.end",
        status: "success",
        result: "done",
        usage: { costUsd: null, durationMs: 12, numTurns: 1, inputTokens: 10, outputTokens: 5 },
      };
      constructor(public opts: AgentRuntimeOpenOptions) {}
      // biome-ignore lint/suspicious/noConfusingVoidType: 与 AgentRuntimeSession 契约一致（void = 仅事件结算）
      send(req: AgentTurnRequest): Promise<void | AgentRuntimeTurnResult> {
        this.requests.push(req);
        this.opts.onEvent(this.endEvent);
        return Promise.resolve({ status: "success", finalText: "done" });
      }
      stop(): void {
        this.stopped = true;
        this.alive = false;
      }
    }

    const bridgeProfile: ResolvedAgentRuntimeProfile = {
      runtime: "bridge",
      model: "gpt-test",
      entrypoint: "ep-graph",
      identity: "id-bridge",
    };

    const makeBridge = () => {
      const sessions: FakeBridgeSession[] = [];
      const driver: AgentRuntimeDriver = {
        driverId: "fake-bridge",
        runtimeIds: ["bridge"],
        openSession: (o) => {
          const s = new FakeBridgeSession(o);
          sessions.push(s);
          return s;
        },
        forgetAgent: vi.fn(),
      };
      harness = makeHarness({
        runtimeRegistry: new AgentRuntimeRegistry([createClaudeRuntimeDriver(), driver]),
        resolveRuntimeProfile: () => bridgeProfile,
      });
      return sessions;
    };

    it("runAgent：bridge 模板（发送者/原文/target 行），无 <slock-reminder>、无 CLI 兜底", async () => {
      const sessions = makeBridge();
      await harness.dispatch.runAgent(AGENT, "general", "#general", "bob", "看下报错");
      await flush();
      const prompt = sessions[0]!.requests[0]!.prompt;
      expect(prompt).toContain("【@bob 在 #general 的消息】");
      expect(prompt).toContain("看下报错");
      expect(prompt).toContain('（本会话 target："#general"）');
      expect(prompt).not.toContain("<slock-reminder>");
      expect(prompt).not.toContain("slock message send");
      expect(prompt).not.toContain("MEMORY.md");
    });

    it("runAgent（线程）：inThread headline 沿用同一判别", async () => {
      const sessions = makeBridge();
      await harness.dispatch.runAgent(AGENT, "general", "#general:t-1", "bob", "跟进", "t-1");
      await flush();
      expect(sessions[0]!.requests[0]!.prompt).toContain("【@bob 在 #general 线程中的消息】");
    });

    it("runAgentDm：bridge dm 模板", async () => {
      const sessions = makeBridge();
      await harness.dispatch.runAgentDm(AGENT, "dm:@bob", "bob", "私下问下");
      await flush();
      const prompt = sessions[0]!.requests[0]!.prompt;
      expect(prompt).toContain("【@bob 的私信】");
      expect(prompt).toContain('（本会话 target："dm:@bob"）');
      expect(prompt).not.toContain("<slock-reminder>");
    });

    it("runAgentTriage：保留【频道分诊】前缀（回复守卫 isNudge 锚点）", async () => {
      const sessions = makeBridge();
      await harness.dispatch.runAgentTriage(AGENT, "general", "#general", "bob", "谁能看下");
      await flush();
      const prompt = sessions[0]!.requests[0]!.prompt;
      expect(prompt).toContain("【频道分诊】");
      expect(prompt).toContain("本回合的最终回答不会被自动发送");
      expect(prompt).not.toContain("<slock-reminder>");
    });

    it("runAgentReminder patrol：保留【定时巡检】前缀", async () => {
      const sessions = makeBridge();
      await harness.dispatch.runAgentReminder(AGENT, {
        kind: "patrol",
        title: "巡检",
        instructions: "看下失败任务",
        channel: "#general",
        id: "rem-1",
      });
      await flush();
      const prompt = sessions[0]!.requests[0]!.prompt;
      expect(prompt.startsWith("【定时巡检】")).toBe(true);
      expect(prompt).not.toContain("slock message send");
      expect(prompt).not.toContain("<slock-reminder>");
    });

    it("runAgentReminder 普通提醒：【提醒触发】模板", async () => {
      const sessions = makeBridge();
      await harness.dispatch.runAgentReminder(AGENT, { title: "喝水", channel: "#general", id: "rem-2" });
      await flush();
      const prompt = sessions[0]!.requests[0]!.prompt;
      expect(prompt).toContain("【提醒触发】喝水");
      expect(prompt).not.toContain("<slock-reminder>");
    });

    it("Claude 回归：runAgent 仍是 A3 任务模板 + <slock-reminder> 尾巴", async () => {
      harness = makeHarness(); // 缺省 resolveRuntimeProfile → claude
      await harness.dispatch.runAgent(AGENT, "general", "#general", "bob", "看下报错");
      await flush();
      const sent = FakePersistentClaude.instances[0]!.sent[0]!;
      expect(sent).toContain("你在 #general 频道被 @ 了");
      expect(sent).toContain("<slock-reminder>");
      expect(sent).toContain("slock message send --target");
    });
  });

  describe("WP7 — message/contextText/resume.value（G2）结构化透传", () => {
    /** 可控 send 的假 bridge 会话——holdFirstSend 让首个回合悬停以构造合并批次 */
    class FakeBridgeSession implements AgentRuntimeSession {
      alive = true;
      requests: AgentTurnRequest[] = [];
      stopped = false;
      /** 前 N 次 send 挂起（resolve 存到 pendingReleases，由测试手动放行） */
      holdSends = 0;
      pendingReleases: Array<() => void> = [];
      result: AgentRuntimeTurnResult = { status: "success", finalText: "done" };
      endEvent: AgentRuntimeEvent = {
        type: "turn.end",
        status: "success",
        result: "done",
        usage: { costUsd: null, durationMs: 12, numTurns: 1 },
      };
      constructor(public opts: AgentRuntimeOpenOptions) {}
      // biome-ignore lint/suspicious/noConfusingVoidType: 与 AgentRuntimeSession 契约一致（void = 仅事件结算）
      send(req: AgentTurnRequest): Promise<void | AgentRuntimeTurnResult> {
        this.requests.push(req);
        if (this.holdSends > 0) {
          this.holdSends--;
          return new Promise((resolve) => this.pendingReleases.push(() => resolve(this.result)));
        }
        this.opts.onEvent(this.endEvent);
        return Promise.resolve(this.result);
      }
      stop(): void {
        this.stopped = true;
        this.alive = false;
      }
    }

    const bridgeProfile: ResolvedAgentRuntimeProfile = {
      runtime: "bridge",
      model: "gpt-test",
      entrypoint: "ep-graph",
      identity: "id-bridge",
    };
    const CONV_CHANNEL = `slock:v1:${AGENT_ID}:channel:general`;

    const makeBridge = (overrides?: { interruptStore?: DispatchDeps["interruptStore"] }) => {
      const sessions: FakeBridgeSession[] = [];
      /** 下次 openSession 新建会话的初始 holdSends——用于「首个回合悬停」构造合并窗口 */
      const state = { nextHoldSends: 0 };
      const driver: AgentRuntimeDriver = {
        driverId: "fake-bridge",
        runtimeIds: ["bridge"],
        openSession: (o) => {
          const s = new FakeBridgeSession(o);
          s.holdSends = state.nextHoldSends;
          state.nextHoldSends = 0;
          sessions.push(s);
          return s;
        },
        forgetAgent: vi.fn(),
      };
      harness = makeHarness({
        runtimeRegistry: new AgentRuntimeRegistry([createClaudeRuntimeDriver(), driver]),
        resolveRuntimeProfile: () => bridgeProfile,
        interruptStore: overrides?.interruptStore,
      });
      return { sessions, state };
    };

    const pendingRec = (over: Record<string, unknown> = {}) => ({
      agentId: AGENT_ID,
      runtime: "bridge",
      entrypoint: "ep-graph",
      conversationId: CONV_CHANNEL,
      interruptId: "int-9",
      resumeToken: "tok-9",
      prompt: "批准？",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      ...over,
    });

    it("dispatchToAgent：message 结构化透传（prompt 保持组装文本，互不相染）", async () => {
      const { sessions } = makeBridge();
      const message = {
        text: "看下附件",
        sender: "alice",
        messageId: "m-7",
        attachments: [{ id: "f1", filename: "a.png", mimeType: "image/png", sizeBytes: 42 }],
      };
      await harness.dispatch.dispatchToAgent(
        AGENT,
        "general",
        "组装后的平台 prompt（含附件摘要行）",
        undefined,
        "message",
        undefined,
        "alice",
        message,
      );
      await flush();
      const req = sessions[0]!.requests[0]!;
      expect(req.message).toEqual(message);
      expect(req.prompt).toBe("组装后的平台 prompt（含附件摘要行）");
      expect(req.contextText).toBeUndefined(); // context builder mock 返回 null
      expect(req.resume).toBeUndefined();
    });

    it("G2：同 conversation 有 pending interrupt 时 resume.value = 原始人类文本而非组装 prompt", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      store.put(pendingRec());
      try {
        const { sessions } = makeBridge({ interruptStore: store });
        await harness.dispatch.dispatchToAgent(
          AGENT,
          "general",
          "组装 prompt：【平台指令…】批准，继续【附件摘要…】",
          undefined,
          "message",
          undefined,
          "alice",
          { text: "批准，继续" },
        );
        await flush();
        const req = sessions[0]!.requests[0]!;
        expect(req.resume).toEqual({ interruptId: "int-9", resumeToken: "tok-9", value: "批准，继续" });
        expect(req.resume?.value).not.toBe(req.prompt);
        expect(req.prompt).toContain("平台指令");
        expect(req.resume?.decision).toBeUndefined(); // 不从纯文本推断决定
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("G2 兜底：无结构化 message 时 resume.value 退回合并 prompt 文本（旧行为兼容）", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      store.put(pendingRec());
      try {
        const { sessions } = makeBridge({ interruptStore: store });
        await harness.dispatch.dispatchToAgent(AGENT, "general", "老的纯文本回复", undefined, "message");
        await flush();
        const req = sessions[0]!.requests[0]!;
        expect(req.resume?.value).toBe("老的纯文本回复");
        expect(req.message).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("contextText：bridge 回合下发历史信封，Claude 回合恒不下发", async () => {
      vi.mocked(buildChannelContextEnvelope).mockResolvedValue({
        block: "<history>近期三条</history>",
        envelope: "<history>近期三条</history>",
        chars: 20,
        kept: 3,
        dropped: 0,
      });
      // —— bridge：contextText 随 turn.start，prompt 仍内嵌同一信封（双通道） ——
      const { sessions } = makeBridge();
      await harness.dispatch.runAgent(AGENT, "general", "#general", "bob", "看下报错");
      await flush();
      let req = sessions[0]!.requests[0]!;
      expect(req.contextText).toBe("<history>近期三条</history>");
      expect(req.prompt).toContain("<history>近期三条</history>");
      expect(req.prompt).toContain("看下报错");

      // —— claude：同一信封只留在 prompt，request.contextText 恒 undefined ——
      harness.dispatch.disposeQueue();
      const claudeSessions: FakeBridgeSession[] = [];
      const claudeDriver: AgentRuntimeDriver = {
        driverId: "fake-claude",
        runtimeIds: ["claude"],
        openSession: (o) => {
          const s = new FakeBridgeSession(o);
          claudeSessions.push(s);
          return s;
        },
        forgetAgent: vi.fn(),
      };
      harness = makeHarness({
        runtimeRegistry: new AgentRuntimeRegistry([claudeDriver]),
        resolveRuntimeProfile: () => ({ runtime: "claude", model: "haiku", identity: "id-claude" }),
      });
      await harness.dispatch.runAgent(AGENT, "general", "#general", "bob", "看下报错");
      await flush();
      req = claudeSessions[0]!.requests[0]!;
      expect(req.contextText).toBeUndefined();
      expect(req.prompt).toContain("<history>近期三条</history>"); // Claude 照旧只吃 prompt
    });

    it("忙碌合并：批次 message 按序合并进单个回合（text/attachments/sender/messageId）", async () => {
      const { sessions, state } = makeBridge();
      state.nextHoldSends = 1; // 首个回合的 send 悬停 → agent 忙 → 后续两条积压合并
      const p1 = harness.dispatch.dispatchToAgent(AGENT, "general", "c1", undefined, "message", undefined, "u1", {
        text: "第一条",
      });
      // 等首个 send 进入挂起态（真实 fs 工作区准备可能 >1 个 flush）
      for (let i = 0; i < 100 && !(sessions[0] && sessions[0]!.requests.length === 1); i++) await flush(10);
      const sess = sessions[0]!;
      expect(sess.requests).toHaveLength(1);
      // c1 在途（send 未结算）→ c2/c3 入队即 pending，同桶合并候选
      const p2 = harness.dispatch.dispatchToAgent(AGENT, "general", "c2", undefined, "message", undefined, "u2", {
        text: "第二条",
        sender: "u2",
        messageId: "m-2",
        attachments: [{ id: "a1", filename: "f1.txt", mimeType: "text/plain", sizeBytes: 1 }],
      });
      const p3 = harness.dispatch.dispatchToAgent(AGENT, "general", "c3", undefined, "message", undefined, "u3", {
        text: "第三条",
        messageId: "m-3",
        attachments: [{ id: "a2", filename: "f2.png", mimeType: "image/png", sizeBytes: 2 }],
      });
      await flush();
      expect(sess.requests).toHaveLength(1); // 只有 c1 送达过
      for (const release of sess.pendingReleases) release(); // 放行 c1 → drain 合并 c2+c3 一批送出
      await Promise.all([p1, p2, p3]);
      await flush();

      expect(sess.requests).toHaveLength(2);
      const merged = sess.requests[1]!;
      expect(merged.message).toEqual({
        text: "第二条\n\n第三条",
        sender: "u2", // 第一条定义值
        messageId: "m-3", // 最后一条定义值
        attachments: [
          { id: "a1", filename: "f1.txt", mimeType: "text/plain", sizeBytes: 1 },
          { id: "a2", filename: "f2.png", mimeType: "image/png", sizeBytes: 2 },
        ],
      });
    });

    it("interrupted 终态：options/kind 随 pending interrupt 落盘", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "slock-istore-"));
      const store = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
      try {
        const { sessions } = makeBridge({ interruptStore: store });
        // 第一回合先开起会话（send 立即 success）
        await harness.dispatch.dispatchToAgent(AGENT, "general", "warm up");
        const sess = sessions[0]!;
        const options = {
          decisions: ["approve", "reject"] as Array<"approve" | "reject">,
          actions: [{ name: "send_email", description: "发邮件", args: { to: "a@b.c" } }],
        };
        sess.result = {
          status: "interrupted",
          interrupt: { interruptId: "int-2", resumeToken: "tok-2", prompt: "批准？", options },
        };
        sess.endEvent = {
          type: "turn.end",
          status: "interrupted",
          usage: { costUsd: null, durationMs: 5, numTurns: 1 },
          interrupt: { interruptId: "int-2", resumeToken: "tok-2", prompt: "批准？", options },
        };
        await harness.dispatch.dispatchToAgent(AGENT, "general", "trigger interrupt");
        await flush();
        const pending = store.list();
        expect(pending).toHaveLength(1);
        expect(pending[0]!.options).toEqual(options);
        expect(pending[0]!.kind).toBe("message");
        expect(pending[0]!.resumeToken).toBe("tok-2");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("系统来源不带 message：reminder/triage 回合恒无结构化消息", async () => {
      const { sessions } = makeBridge();
      await harness.dispatch.runAgentReminder(AGENT, { title: "喝水", channel: "#general", id: "rem-9" });
      await harness.dispatch.runAgentTriage(AGENT, "general", "#general", "bob", "谁能看下");
      await flush();
      for (const req of sessions[0]!.requests) {
        expect(req.message).toBeUndefined();
        expect(req.source.kind).not.toBe("message");
      }
    });
  });
});
