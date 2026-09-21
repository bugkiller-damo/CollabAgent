import { describe, expect, it, vi } from "vitest";
import { createObservationBus, createSeqAllocator, type ObservationFrame } from "../src/agent-observation.js";
import type { ProgressPoster, ProgressTurn } from "../src/agent-progress.js";
import {
  abortTurnGuards,
  armTurnGuard,
  createStreamTurnHandler,
  REPLY_GUARD_PREFIX,
  type StreamTurnHandlerOpts,
  type TurnGuard,
} from "../src/agent-runtime-dispatch-stream.js";
import type { AgentRuntimeEvent } from "../src/agent-runtime-events.js";
import { createAgentStateMachine } from "../src/agent-runtime-state.js";
import type { IIdleReclaimer } from "../src/idle-reclaimer.js";

/**
 * A8：createStreamTurnHandler 的最小直连测试（无 driver / 无 server——
 * Phase 0 起 handler 只消费规范化 AgentRuntimeEvent，provider 原始事件
 * 经 drivers/claude-runtime.ts 的 normalizer 转换，其单测在 claude-runtime.test.ts）。
 *
 * 钉住的契约：工具审计（onToolCall pending/completed）、回复守卫簿记与进度
 * 更新是安全边界，独立于可选的 observationBus——bus 缺席只停发观察帧，
 * 绝不跳过审计。帧文本统一过 P1.15 脱敏（sk_agent_/sk_machine_ token 不出边界）。
 */

const TOKEN = "sk_agent_abcd1234abcd1234abcd1234abcd1234";

type ToolCallInfo = { toolName?: string; toolUseId?: string; status: "pending" | "completed"; text?: string };

const stubIdleReclaimer = (): IIdleReclaimer => ({
  touch: vi.fn(),
  untrack: vi.fn(),
  getIdleMs: () => 0,
  start: vi.fn(),
  stop: vi.fn(),
});

/** 缺省不提供 observationBus——关键审计用例刻意不带 UI 旁路 */
const makeHandler = (overrides: Partial<StreamTurnHandlerOpts> = {}) => {
  const deps = {
    obsSeq: createSeqAllocator(),
    turnGuards: new Map<string, TurnGuard>(),
    progressTurns: new Map<string, ProgressTurn>(),
    stateMachine: createAgentStateMachine(),
    idleReclaimer: stubIdleReclaimer(),
    resolveAgentId: () => "agent-id-1",
    nudge: vi.fn(),
    ...overrides,
  };
  return { handler: createStreamTurnHandler(deps), deps };
};

const bashToolUse = (id: string, command: string): AgentRuntimeEvent => ({
  type: "tool.start",
  turnId: "msg-1",
  toolName: "Bash",
  toolUseId: id,
  input: { command },
});

const toolResult = (id: string, content: string): AgentRuntimeEvent => ({
  type: "tool.end",
  toolUseId: id,
  output: content,
});

describe("createStreamTurnHandler（A8：审计独立于 observationBus）", () => {
  it("A8：无 observationBus 时 tool_use/tool_result 仍走完整审计生命周期且文本脱敏", () => {
    const calls: Array<{ agentName: string; info: ToolCallInfo }> = [];
    const { handler } = makeHandler({ onToolCall: (agentName, info) => calls.push({ agentName, info }) });

    handler("alice", bashToolUse("tu-1", `echo ${TOKEN}`));
    handler("alice", toolResult("tu-1", `done ${TOKEN}`));

    expect(calls).toHaveLength(2);
    // pending：tool_use 出现即发，payload 文本已脱敏
    expect(calls[0]!.agentName).toBe("alice");
    expect(calls[0]!.info.toolName).toBe("Bash");
    expect(calls[0]!.info.toolUseId).toBe("tu-1");
    expect(calls[0]!.info.status).toBe("pending");
    expect(calls[0]!.info.text).toContain("echo");
    expect(calls[0]!.info.text).toContain("sk_agent_***");
    expect(calls[0]!.info.text).not.toContain(TOKEN);
    // completed：tool.end 回灌；tool.end 只带 id，toolName 可为空
    expect(calls[1]!.info.toolUseId).toBe("tu-1");
    expect(calls[1]!.info.status).toBe("completed");
    expect(calls[1]!.info.text).toContain("done");
    expect(calls[1]!.info.text).toContain("sk_agent_***");
    expect(calls[1]!.info.text).not.toContain(TOKEN);
  });

  it("A8：审计回调是非阻塞旁路——onToolCall 抛错不阻断事件处理", () => {
    const { handler } = makeHandler({
      onToolCall: () => {
        throw new Error("audit sink exploded");
      },
    });
    expect(() => handler("alice", bashToolUse("tu-9", "ls"))).not.toThrow();
    expect(() => handler("alice", toolResult("tu-9", "ok"))).not.toThrow();
  });

  it("A8：提供 observationBus 时观察帧照常发布，且审计仍恰好触发一次", () => {
    const bus = createObservationBus();
    const seen: ObservationFrame[] = [];
    bus.subscribe("alice", (f) => seen.push(f));
    const onToolCall = vi.fn();
    const { handler } = makeHandler({ observationBus: bus, onToolCall });

    handler("alice", bashToolUse("tu-1", "ls"));

    const toolFrames = seen.filter((f) => f.kind === "tool_use");
    expect(toolFrames).toHaveLength(1);
    expect(toolFrames[0]!.payload.toolName).toBe("Bash");
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ toolName: "Bash", toolUseId: "tu-1", status: "pending" }),
    );
  });
});

describe("armTurnGuard（A4：kind 传入守卫判 isNudge）", () => {
  const resultEvent: AgentRuntimeEvent = {
    type: "turn.end",
    status: "success",
    subtype: "success",
    usage: { costUsd: 0, durationMs: null, numTurns: null },
  };
  const textEvent = (text: string): AgentRuntimeEvent => ({ type: "text", turnId: "msg-t", text });
  const flush = () => new Promise((r) => setTimeout(r, 20));

  const arm = (deps: ReturnType<typeof makeHandler>["deps"], opts: { kind?: string; userMsg?: string } = {}) =>
    armTurnGuard({
      agentName: "alice",
      channelName: "general",
      userMsg: opts.userMsg ?? "随便一段内容",
      kind: opts.kind,
      turnGuards: deps.turnGuards,
      progressTurns: deps.progressTurns,
    });

  it("A4：kind=triage 判 isNudge——回合无 send 不代发不追问", async () => {
    const onReplyMissing = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing });
    deps.stateMachine.transitionState("alice", "idle");
    deps.stateMachine.transitionState("alice", "working");
    arm(deps, { kind: "triage", userMsg: "无前缀文本也应判 isNudge" });

    handler("alice", textEvent("无需介入，沉默"));
    handler("alice", resultEvent);
    await flush();

    expect(deps.turnGuards.size).toBe(0);
    expect(onReplyMissing).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it("A4：kind=message 保持守卫——无 send 有正文时走代发", async () => {
    const onReplyMissing = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing });
    deps.stateMachine.transitionState("alice", "idle");
    deps.stateMachine.transitionState("alice", "working");
    arm(deps, { kind: "message" });

    handler("alice", textEvent("这是答案正文"));
    handler("alice", resultEvent);
    await flush();

    expect(onReplyMissing).toHaveBeenCalledTimes(1);
    expect(onReplyMissing).toHaveBeenCalledWith("alice", "general", "这是答案正文");
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it("A4：kind=reminder 不带巡检前缀时仍受守卫（普通 ⏰ 提醒语义不变）", async () => {
    const onReplyMissing = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing });
    deps.stateMachine.transitionState("alice", "idle");
    deps.stateMachine.transitionState("alice", "working");
    arm(deps, { kind: "reminder", userMsg: "⏰ 你之前设置的提醒触发了" });

    handler("alice", textEvent("跟进结果正文"));
    handler("alice", resultEvent);
    await flush();

    expect(onReplyMissing).toHaveBeenCalledTimes(1);
  });
});

/**
 * A6：守卫三分支（hadSend / 代发 / 追问）+ abort + 成本差值——A1–A5 的安全网。
 * 代发分支已由上方 kind=message/reminder 两例覆盖，这里补齐其余面。
 */
describe("回复守卫三分支 / abort / 成本落库（A6）", () => {
  const resultEvent = (costUsd = 0): AgentRuntimeEvent => ({
    type: "turn.end",
    status: "success",
    subtype: "success",
    usage: { costUsd, durationMs: 100, numTurns: 1 },
  });
  const textEvent = (text: string): AgentRuntimeEvent => ({ type: "text", turnId: "msg-t", text });
  const sendToolEvent: AgentRuntimeEvent = {
    type: "tool.start",
    turnId: "msg-s",
    toolName: "mcp__slock__send_message",
    toolUseId: "tu-s",
    input: { target: "#general", content: "hi" },
  };
  const flush = () => new Promise((r) => setTimeout(r, 20));

  const working = (deps: ReturnType<typeof makeHandler>["deps"]): void => {
    deps.stateMachine.transitionState("alice", "idle");
    deps.stateMachine.transitionState("alice", "working");
  };

  const arm = (
    deps: ReturnType<typeof makeHandler>["deps"],
    opts: { kind?: string; userMsg?: string; createProgressPoster?: () => ProgressPoster } = {},
  ) =>
    armTurnGuard({
      agentName: "alice",
      channelName: "general",
      userMsg: opts.userMsg ?? "随便一段内容",
      kind: opts.kind,
      turnGuards: deps.turnGuards,
      progressTurns: deps.progressTurns,
      createProgressPoster: opts.createProgressPoster,
    });

  it("分支一 hadSend：本回合已调 send_message → 不代发不追问，守卫清掉", async () => {
    const onReplyMissing = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing });
    working(deps);
    arm(deps, { kind: "message" });

    handler("alice", sendToolEvent);
    handler("alice", resultEvent(0.01));
    await flush();

    expect(onReplyMissing).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
    expect(deps.turnGuards.size).toBe(0);
    expect(deps.stateMachine.getState("alice")).toBe("idle");
  });

  it("分支三 无正文：回合结束没发也没文本 → nudge 一次（带守卫前缀），不代发", async () => {
    const onReplyMissing = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing });
    working(deps);
    arm(deps, { kind: "message" });

    // 只有工具调用，没有任何 text 帧
    handler("alice", bashToolUse("tu-1", "ls"));
    handler("alice", resultEvent(0.01));
    await flush();

    expect(onReplyMissing).not.toHaveBeenCalled();
    expect(deps.nudge).toHaveBeenCalledTimes(1);
    const [nAgent, nChannel, nMsg] = deps.nudge.mock.calls[0]!;
    expect(nAgent).toBe("alice");
    expect(nChannel).toBe("general");
    expect(nMsg).toContain(REPLY_GUARD_PREFIX);
    expect(nMsg).toContain('target="general"');
  });

  it("分支三补充：nudge 携带原始用户文本（新 thread 缺上下文时仍能作答）", async () => {
    const { handler, deps } = makeHandler();
    working(deps);
    arm(deps, { kind: "message", userMsg: "查看今天徐州天气" });

    handler("alice", resultEvent(0.01));
    await flush();

    expect(deps.nudge).toHaveBeenCalledTimes(1);
    const nMsg = deps.nudge.mock.calls[0]![2] as string;
    expect(nMsg).toContain("查看今天徐州天气");
  });

  it("error 终态不走守卫：不代发残文本也不追问（死信已由队列上报）", async () => {
    const onReplyMissing = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing });
    working(deps);
    arm(deps, { kind: "message" });

    // 实机踩坑：error 回合触发 nudge → 模型在无原文的新 thread 里翻历史乱答
    handler("alice", textEvent("半截输出"));
    handler("alice", {
      type: "turn.end",
      status: "error",
      subtype: "error_during_execution",
      usage: { costUsd: null, durationMs: null, numTurns: null },
    });
    await flush();

    expect(onReplyMissing).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
    expect(deps.turnGuards.size).toBe(0);
  });

  it("interrupted/cancelled 终态豁免守卫（等 resume / 主动停止）", async () => {
    for (const status of ["interrupted", "cancelled"] as const) {
      const onReplyMissing = vi.fn();
      const { handler, deps } = makeHandler({ onReplyMissing });
      working(deps);
      arm(deps, { kind: "message" });
      handler("alice", textEvent("等审批中"));
      handler("alice", {
        type: "turn.end",
        status,
        subtype: status,
        usage: { costUsd: null, durationMs: null, numTurns: null },
      });
      await flush();
      expect(onReplyMissing).not.toHaveBeenCalled();
      expect(deps.nudge).not.toHaveBeenCalled();
    }
  });

  it("分支二 rewritten：进度条已发且可改写 → 回复被改写吸收，不再代发", async () => {
    const poster = {
      post: vi.fn(async () => "pm-1"),
      edit: vi.fn(async () => true),
      remove: vi.fn(async () => false),
    };
    const onReplyMissing = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing });
    working(deps);
    arm(deps, { kind: "message", createProgressPoster: () => poster });

    // text 帧触发进度条首发（post → messageId=pm-1）
    handler("alice", textEvent("这是答案正文"));
    await flush();
    expect(poster.post).toHaveBeenCalledTimes(1);

    handler("alice", resultEvent(0.01));
    await flush();

    // 进度条被改写成最终正文（rewrite 分支）→ 代发不再触发
    expect(poster.edit).toHaveBeenCalledWith("pm-1", "这是答案正文");
    expect(onReplyMissing).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it("abortTurnGuards：拆守卫删进度条 + onProgress(end)，迟到的 result 不再触发任何守卫动作", async () => {
    const poster = {
      post: vi.fn(async () => "pm-1"),
      edit: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    const onReplyMissing = vi.fn();
    const onProgress = vi.fn();
    const { handler, deps } = makeHandler({ onReplyMissing, onProgress });
    working(deps);
    arm(deps, { kind: "message", createProgressPoster: () => poster });
    handler("alice", textEvent("写了半截"));
    await flush();
    expect(poster.post).toHaveBeenCalledTimes(1);

    abortTurnGuards("alice", deps.turnGuards, deps.progressTurns, onProgress);
    await flush();

    expect(deps.turnGuards.size).toBe(0);
    expect(deps.progressTurns.size).toBe(0);
    expect(poster.remove).toHaveBeenCalledWith("pm-1");
    expect(onProgress).toHaveBeenCalledWith("alice", "general", "", "end");

    // 迟到的 turn.end：守卫已拆，不代发不追问；状态机照常回 idle
    handler("alice", resultEvent(0.01));
    await flush();
    expect(onReplyMissing).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
    expect(deps.stateMachine.getState("alice")).toBe("idle");
  });

  it("成本落库：turn.end.usage 已是本回合增量，原样写库；channel/threadId 取守卫", async () => {
    const recordTurn = vi.fn();
    const { handler, deps } = makeHandler({ costTracker: { recordTurn } as never });

    working(deps);
    arm(deps, { kind: "message" });
    handler("alice", resultEvent(0.05));

    // 守卫在 turn.end 时已被清掉——再 arm 一次让第二条也带 channel
    working(deps);
    arm(deps, { kind: "message" });
    handler("alice", resultEvent(0.07));
    await flush();

    expect(recordTurn).toHaveBeenCalledTimes(2);
    expect(recordTurn.mock.calls[0]![0]).toMatchObject({
      agentName: "alice",
      agentId: "agent-id-1",
      channel: "general",
      costUsd: 0.05,
      durationMs: 100,
      numTurns: 1,
    });
    // usage 原样透传（累计→差值是 driver 边界的职责，见 claude-runtime.test.ts）
    expect(recordTurn.mock.calls[1]![0].costUsd).toBeCloseTo(0.07, 10);
  });

  it("usage 全 null 的 turn.end 仍记一笔（回合计数不丢）", async () => {
    const recordTurn = vi.fn();
    const { handler, deps } = makeHandler({ costTracker: { recordTurn } as never });

    working(deps);
    arm(deps, { kind: "message" });
    handler("alice", {
      type: "turn.end",
      status: "error",
      subtype: "error_during_execution",
      usage: { costUsd: null, durationMs: null, numTurns: null },
    });
    await flush();

    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn.mock.calls[0]![0]).toMatchObject({
      agentName: "alice",
      channel: "general",
      costUsd: null,
      durationMs: null,
      numTurns: null,
    });
  });
});
