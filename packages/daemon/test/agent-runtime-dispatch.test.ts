import { rmSync } from "node:fs";
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
const { FakePersistentClaude, claudePrintMock, claudePrintImpl } = vi.hoisted(() => {
  class FakePersistentClaude {
    static instances: FakePersistentClaude[] = [];
    static reset(): void {
      FakePersistentClaude.instances = [];
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
    send(text: string): Promise<void> {
      this.sent.push(text);
      return this.sendImpl ? this.sendImpl(text, this) : Promise.resolve();
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
  return { FakePersistentClaude, claudePrintMock, claudePrintImpl };
});

vi.mock("../src/drivers/persistent-claude.js", () => ({ PersistentClaude: FakePersistentClaude }));
vi.mock("../src/claude-print.js", () => ({ claudePrint: claudePrintMock }));
vi.mock("../src/mcp-bundle.js", () => ({ bundleSlockMcpServer: async () => null }));
vi.mock("../src/agent-context-builder.js", () => ({
  buildThreadContextEnvelope: vi.fn(async () => null),
}));

import { buildThreadContextEnvelope } from "../src/agent-context-builder.js";
import { createObservationBus } from "../src/agent-observation.js";
import { createDispatch, type DispatchDeps, type IDispatch } from "../src/agent-runtime-dispatch.js";
import { createAgentStateMachine, type IAgentStateMachine } from "../src/agent-runtime-state.js";
import { createTurnTracker } from "../src/agent-runtime-turn-tracker.js";
import { createIdleReclaimer } from "../src/idle-reclaimer.js";

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
    usePty: false,
    resolveAgentId: overrides?.resolveAgentId ?? ((n) => (n === AGENT ? AGENT_ID : n === AGENT2 ? AGENT2_ID : null)),
    agentInfo: new Map(),
    runIdByAgent: new Map(),
    persistentSessions: new Map(),
    agentSessions: new Map(),
    dispatchPromises: new Map(),
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
    rmSync(join(process.cwd(), ".slock", `sysprompt-${name}.md`), { force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(join(process.cwd(), ".slock", "workspaces", name), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
};

describe("agent-runtime-dispatch (headless)", () => {
  let harness: Harness;

  beforeEach(() => {
    FakePersistentClaude.reset();
    vi.mocked(buildThreadContextEnvelope).mockReset().mockResolvedValue(null);
    delete process.env.SLOCK_COST_BUDGET_USD;
    delete process.env.SLOCK_DISPATCH_MAX_RETRIES;
    delete process.env.SLOCK_DISPATCH_QUEUE;
    delete process.env.SLOCK_REPLY_GUARD;
    delete process.env.SLOCK_CHANNEL_PROGRESS;
    delete process.env.SLOCK_ONESHOT_CLAUDE;
    claudePrintMock.mockReset();
    claudePrintMock.mockImplementation(claudePrintImpl);
  });

  afterEach(() => {
    harness?.dispatch.disposeQueue();
    cleanupWorkspace(AGENT);
    cleanupWorkspace(AGENT2);
    delete process.env.SLOCK_COST_BUDGET_USD;
    delete process.env.SLOCK_DISPATCH_MAX_RETRIES;
    delete process.env.SLOCK_DISPATCH_QUEUE;
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

    it("旧门控链（SLOCK_DISPATCH_QUEUE=0）：doDispatch 入口兜底门同样拦截", async () => {
      const tracker = makeTracker();
      tracker.spend = 9;
      process.env.SLOCK_COST_BUDGET_USD = "1";
      process.env.SLOCK_DISPATCH_QUEUE = "0"; // 必须早于 createDispatch
      harness = makeHarness({ tracker });

      await harness.dispatch.dispatchToAgent(AGENT, "general", "legacy-blocked");
      await flush();
      expect(FakePersistentClaude.instances).toHaveLength(0);
      expect(harness.onCircuitBreak).toHaveBeenCalledTimes(1);
    });

    it("旧门控链：两条消息串行投递，顺序保持", async () => {
      process.env.SLOCK_DISPATCH_QUEUE = "0";
      harness = makeHarness();
      const p1 = harness.dispatch.dispatchToAgent(AGENT, "general", "first-msg");
      const p2 = harness.dispatch.dispatchToAgent(AGENT, "general", "second-msg");
      await p1;
      await p2;
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent).toHaveLength(2);
      expect(inst.sent[0]).toContain("first-msg");
      expect(inst.sent[1]).toContain("second-msg");
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

    it("runAgent 无线程：不拉历史，顶层文案", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgent(AGENT, "general", "#general", "bob", "顶层问题");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("#general 频道被 @ 了");
      expect(inst.sent[0]).not.toContain("<<ctx-envelope>>");
      expect(buildThreadContextEnvelope).not.toHaveBeenCalled();
    });

    it("context builder 返回 null 时退回裸 prompt（不失忆也不阻断）", async () => {
      harness = makeHarness(); // 默认 mockResolvedValue(null)
      await harness.dispatch.runAgent(AGENT, "general", "#general:t1", "bob", "问题", "t1");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("问题");
      expect(inst.sent[0]).not.toContain("<<ctx-envelope>>");
      expect(harness.tracker.recordContext).not.toHaveBeenCalled();
    });

    it("runAgentDm：私信 prompt 与 dm 回执 target", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgentDm(AGENT, "dm:@bob", "bob", "在吗");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("私信（DM）");
      expect(inst.sent[0]).toContain('target="dm:@bob"');
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

    it("runAgentTriage：分诊模板", async () => {
      harness = makeHarness();
      await harness.dispatch.runAgentTriage(AGENT, "general", "#general", "bob", "谁能看下这个");
      const inst = FakePersistentClaude.instances[0]!;
      expect(inst.sent[0]).toContain("【频道分诊】#general");
      expect(inst.sent[0]).toContain("@bob");
      expect(inst.sent[0]).toContain("dispatch_task");
    });
  });
});
