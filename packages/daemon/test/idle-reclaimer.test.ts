import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistentClaude } from "../src/drivers/persistent-claude.js";
import { createIdleReclaimer, reclaimIdleAgent } from "../src/idle-reclaimer.js";

/**
 * Idle Reclaimer + P0.2 headless 回收动作。
 *
 * reclaimer 本身是纯计时器：timeout 到 → onReclaim；返回 false 则保留跟踪。
 * reclaimIdleAgent 是 runtime 注入的动作：PTY stopRun / headless session.stop。
 */

describe("createIdleReclaimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("空闲超过 timeout 后调用 onReclaim 并 untrack", () => {
    const onReclaim = vi.fn();
    const r = createIdleReclaimer({ timeoutMs: 100, scanIntervalMs: 50, onReclaim });
    r.start();
    r.touch("alice");

    vi.advanceTimersByTime(50);
    expect(onReclaim).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(onReclaim).toHaveBeenCalledTimes(1);
    expect(onReclaim.mock.calls[0]![0]).toBe("alice");
    expect(onReclaim.mock.calls[0]![1]).toBeGreaterThanOrEqual(100);

    vi.advanceTimersByTime(100);
    expect(onReclaim).toHaveBeenCalledTimes(1);
    r.stop();
  });

  it("onReclaim 返回 false 时保留跟踪，下次扫描再试", () => {
    const onReclaim = vi.fn().mockReturnValue(false);
    const r = createIdleReclaimer({ timeoutMs: 100, scanIntervalMs: 50, onReclaim });
    r.start();
    r.touch("alice");

    vi.advanceTimersByTime(100);
    expect(onReclaim).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    expect(onReclaim).toHaveBeenCalledTimes(2);
    r.stop();
  });

  it("onReclaim 抛错仍 untrack，避免反复打同一 agent", () => {
    const onReclaim = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const r = createIdleReclaimer({ timeoutMs: 100, scanIntervalMs: 50, onReclaim });
    r.start();
    r.touch("alice");

    vi.advanceTimersByTime(100);
    expect(onReclaim).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(onReclaim).toHaveBeenCalledTimes(1);
    r.stop();
  });

  it("untrack 后不再回收；touch 重置空闲计时", () => {
    const onReclaim = vi.fn();
    const r = createIdleReclaimer({ timeoutMs: 100, scanIntervalMs: 50, onReclaim });
    r.start();
    r.touch("alice");
    vi.advanceTimersByTime(50);
    r.touch("alice");
    vi.advanceTimersByTime(50);
    expect(onReclaim).not.toHaveBeenCalled();

    r.untrack("alice");
    vi.advanceTimersByTime(200);
    expect(onReclaim).not.toHaveBeenCalled();
    r.stop();
  });

  it("未 touch 的 agent getIdleMs 为 0", () => {
    const r = createIdleReclaimer({ onReclaim: () => {} });
    expect(r.getIdleMs("ghost")).toBe(0);
    r.stop();
  });
});

describe("reclaimIdleAgent (P0.2)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeSession = () => {
    const stop = vi.fn();
    return { session: { stop } as unknown as PersistentClaude, stop };
  };

  it("headless：stop 会话并从 persistentSessions 删除", () => {
    const { session, stop } = makeSession();
    const persistentSessions = new Map([["alice", session]]);
    const agentManager = { stopRun: vi.fn() };
    const stateMachine = { getState: vi.fn().mockReturnValue("idle"), transitionState: vi.fn() };

    reclaimIdleAgent({
      name: "alice",
      runIdByAgent: new Map(),
      agentManager,
      persistentSessions,
      stateMachine,
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(persistentSessions.has("alice")).toBe(false);
    expect(agentManager.stopRun).not.toHaveBeenCalled();
    expect(stateMachine.transitionState).not.toHaveBeenCalled();
  });

  it("PTY：stopRun，不碰 headless map", () => {
    const persistentSessions = new Map<string, PersistentClaude>();
    const agentManager = { stopRun: vi.fn() };
    const stateMachine = { getState: vi.fn().mockReturnValue("idle"), transitionState: vi.fn() };

    reclaimIdleAgent({
      name: "alice",
      runIdByAgent: new Map([["alice", "run-1"]]),
      agentManager,
      persistentSessions,
      stateMachine,
    });

    expect(agentManager.stopRun).toHaveBeenCalledWith("run-1");
    expect(persistentSessions.size).toBe(0);
  });

  it("working / starting 时跳过（返回 false），不杀进程", () => {
    const { session, stop } = makeSession();
    const persistentSessions = new Map([["alice", session]]);
    const agentManager = { stopRun: vi.fn() };

    for (const status of ["working", "starting"] as const) {
      stop.mockClear();
      agentManager.stopRun.mockClear();
      const result = reclaimIdleAgent({
        name: "alice",
        runIdByAgent: new Map([["alice", "run-1"]]),
        agentManager,
        persistentSessions,
        stateMachine: { getState: () => status, transitionState: vi.fn() },
      });
      expect(result).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      expect(agentManager.stopRun).not.toHaveBeenCalled();
      expect(persistentSessions.get("alice")).toBe(session);
    }
  });

  it("无会话无 PTY 时是 no-op", () => {
    const agentManager = { stopRun: vi.fn() };
    const stateMachine = { getState: vi.fn().mockReturnValue("idle"), transitionState: vi.fn() };
    const result = reclaimIdleAgent({
      name: "alice",
      runIdByAgent: new Map(),
      agentManager,
      persistentSessions: new Map(),
      stateMachine,
    });
    expect(result).toBeUndefined();
    expect(agentManager.stopRun).not.toHaveBeenCalled();
    expect(stateMachine.transitionState).not.toHaveBeenCalled();
  });

  it("stopped 残留会话：杀进程但不改状态机", () => {
    const { session, stop } = makeSession();
    const persistentSessions = new Map([["alice", session]]);
    const stateMachine = { getState: vi.fn().mockReturnValue("stopped"), transitionState: vi.fn() };

    reclaimIdleAgent({
      name: "alice",
      runIdByAgent: new Map(),
      agentManager: { stopRun: vi.fn() },
      persistentSessions,
      stateMachine,
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(persistentSessions.has("alice")).toBe(false);
    expect(stateMachine.transitionState).not.toHaveBeenCalled();
  });
});
