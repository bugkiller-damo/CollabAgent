import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.11：PTY 路径没有 stream-json result，doDispatch 在 dispatchPtyTurn 成功后
 * 记一笔 costUsd=0 的回合，避免花钱黑盒。本文件独立 mock pty 模块，不碰冻结文件。
 */

vi.mock("../src/agent-runtime-dispatch-pty.js", () => ({
  dispatchPtyTurn: vi.fn(async () => {}),
}));
vi.mock("../src/mcp-bundle.js", () => ({ bundleSlockMcpServer: async () => null }));
vi.mock("../src/agent-context-builder.js", () => ({
  buildThreadContextEnvelope: vi.fn(async () => null),
}));

import { createObservationBus } from "../src/agent-observation.js";
import { createDispatch, type DispatchDeps, type IDispatch } from "../src/agent-runtime-dispatch.js";
import { dispatchPtyTurn } from "../src/agent-runtime-dispatch-pty.js";
import { createAgentStateMachine, type IAgentStateMachine } from "../src/agent-runtime-state.js";
import { createTurnTracker } from "../src/agent-runtime-turn-tracker.js";
import { createIdleReclaimer } from "../src/idle-reclaimer.js";

const AGENT = "zz_pty_cost_agent";
const AGENT_ID = "33333333-3333-3333-3333-333333333333";

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
    return name === AGENT ? this.spend : 0;
  },
  spendByAgent: () => [],
  listRecords: () => [],
});

interface Harness {
  dispatch: IDispatch;
  stateMachine: IAgentStateMachine;
  tracker: FakeTracker;
}

const makeHarness = (overrides?: { tracker?: FakeTracker | undefined }): Harness => {
  const stateMachine = createAgentStateMachine();
  stateMachine.transitionState(AGENT, "idle");
  const tracker = overrides && "tracker" in overrides ? overrides.tracker : makeTracker();
  const mintAgentCredential = vi.fn(async () => "sk_agent_test_token");

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
    usePty: true,
    resolveAgentId: (n) => (n === AGENT ? AGENT_ID : null),
    agentInfo: new Map(),
    runIdByAgent: new Map(),
    persistentSessions: new Map(),
    agentSessions: new Map(),
    dispatchPromises: new Map(),
    observationBus: createObservationBus(),
    costTracker: tracker as any,
    onReplyMissing: vi.fn(),
    onCircuitBreak: vi.fn(),
    onDeliveryQueued: vi.fn(),
    onDeliveryDeadLetter: vi.fn(),
    abortAgentProcess: vi.fn(),
  };
  return { dispatch: createDispatch(deps), stateMachine, tracker: tracker ?? makeTracker() };
};

describe("P1.11 PTY cost record (doDispatch hook)", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.mocked(dispatchPtyTurn).mockClear().mockResolvedValue(undefined);
    delete process.env.SLOCK_COST_BUDGET_USD;
    delete process.env.SLOCK_DISPATCH_MAX_RETRIES;
    delete process.env.SLOCK_DISPATCH_QUEUE;
  });

  afterEach(() => {
    harness?.dispatch.disposeQueue();
    delete process.env.SLOCK_COST_BUDGET_USD;
    delete process.env.SLOCK_DISPATCH_MAX_RETRIES;
    delete process.env.SLOCK_DISPATCH_QUEUE;
  });

  it("records a zero-USD turn after successful dispatchPtyTurn", async () => {
    harness = makeHarness();
    await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
    await flush();

    expect(dispatchPtyTurn).toHaveBeenCalledTimes(1);
    expect(harness.tracker.recordTurn).toHaveBeenCalledTimes(1);
    expect(harness.tracker.recordTurn.mock.calls[0][0]).toMatchObject({
      agentName: AGENT,
      agentId: AGENT_ID,
      channel: "general",
      costUsd: 0,
    });
  });

  it("does not record when dispatchPtyTurn throws", async () => {
    process.env.SLOCK_DISPATCH_MAX_RETRIES = "1";
    vi.mocked(dispatchPtyTurn).mockRejectedValue(new Error("pty boom"));
    harness = makeHarness();
    await harness.dispatch.dispatchToAgent(AGENT, "general", "hi");
    await flush(80);

    expect(harness.tracker.recordTurn).not.toHaveBeenCalled();
  });
});
