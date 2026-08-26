import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P1.12：headless 会话创建单飞 + send 失败踢 stale session。
 */

const { FakePersistentClaude } = vi.hoisted(() => {
  class FakePersistentClaude {
    static instances: FakePersistentClaude[] = [];
    static defaultSendImpl?: (text: string) => Promise<void>;
    static reset(): void {
      FakePersistentClaude.instances = [];
      FakePersistentClaude.defaultSendImpl = undefined;
    }
    sent: string[] = [];
    stopped = false;
    constructor(_opts: unknown) {
      FakePersistentClaude.instances.push(this);
    }
    send(text: string): Promise<void> {
      this.sent.push(text);
      const impl = FakePersistentClaude.defaultSendImpl;
      return impl ? impl(text) : Promise.resolve();
    }
    stop(): void {
      this.stopped = true;
    }
  }
  return { FakePersistentClaude };
});

vi.mock("../src/drivers/persistent-claude.js", () => ({ PersistentClaude: FakePersistentClaude }));
vi.mock("../src/mcp-bundle.js", () => ({ bundleSlockMcpServer: async () => null }));
vi.mock("../src/agent-startup.js", () => ({
  writeSystemPromptFile: () => "prompt.md",
  createWorkspaceDir: () => "D:/tmp-p112",
}));
vi.mock("../src/agent-token-file.js", () => ({
  writeAgentTokenFile: () => "token-path",
}));

import {
  type DispatchHeadlessTurnOpts,
  dispatchHeadlessTurn,
  dropStalePersistentSession,
  ensurePersistentSession,
} from "../src/agent-runtime-dispatch-headless.js";
import { createAgentStateMachine } from "../src/agent-runtime-state.js";
import type { PersistentClaude } from "../src/drivers/persistent-claude.js";
import { createIdleReclaimer } from "../src/idle-reclaimer.js";

const fakeSession = (label: string) =>
  ({
    label,
    stop: vi.fn(),
  }) as unknown as PersistentClaude & { label: string; stop: ReturnType<typeof vi.fn> };

describe("ensurePersistentSession (P1.12)", () => {
  it("已有会话直接返回，不调 create", async () => {
    const existing = fakeSession("a");
    const sessions = new Map<string, PersistentClaude>([["alice", existing]]);
    const locks = new Map<string, Promise<PersistentClaude>>();
    const create = vi.fn(() => fakeSession("b"));

    const got = await ensurePersistentSession("alice", sessions, locks, create);
    expect(got).toBe(existing);
    expect(create).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
  });

  it("同 tick 两次 ensure 只 create 一次，共用同一实例", async () => {
    const sessions = new Map<string, PersistentClaude>();
    const locks = new Map<string, Promise<PersistentClaude>>();
    const create = vi.fn(() => fakeSession("only"));

    const p1 = ensurePersistentSession("alice", sessions, locks, create);
    const p2 = ensurePersistentSession("alice", sessions, locks, create);
    const [a, b] = await Promise.all([p1, p2]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(sessions.get("alice")).toBe(a);
    expect(locks.size).toBe(0);
  });

  it("create 抛错不占 map，锁释放后可重试", async () => {
    const sessions = new Map<string, PersistentClaude>();
    const locks = new Map<string, Promise<PersistentClaude>>();
    const boom = vi.fn(() => {
      throw new Error("spawn failed");
    });

    await expect(ensurePersistentSession("alice", sessions, locks, boom)).rejects.toThrow(/spawn failed/);
    expect(sessions.size).toBe(0);
    await Promise.resolve();
    expect(locks.size).toBe(0);

    const ok = fakeSession("ok");
    const got = await ensurePersistentSession("alice", sessions, locks, () => ok);
    expect(got).toBe(ok);
    expect(sessions.get("alice")).toBe(ok);
  });
});

describe("dropStalePersistentSession (P1.12)", () => {
  it("只踢本回合持有的实例，并 stop + forget", () => {
    const mine = fakeSession("mine");
    const sessions = new Map<string, PersistentClaude>([["alice", mine]]);
    const forget = vi.fn();

    dropStalePersistentSession("alice", sessions, mine, forget);
    expect(mine.stop).toHaveBeenCalledTimes(1);
    expect(sessions.has("alice")).toBe(false);
    expect(forget).toHaveBeenCalledWith("alice");
  });

  it("map 里已是别人的实例则不 stop、不 delete", () => {
    const mine = fakeSession("mine");
    const winner = fakeSession("winner");
    const sessions = new Map<string, PersistentClaude>([["alice", winner]]);
    const forget = vi.fn();

    dropStalePersistentSession("alice", sessions, mine, forget);
    expect(mine.stop).not.toHaveBeenCalled();
    expect(winner.stop).not.toHaveBeenCalled();
    expect(sessions.get("alice")).toBe(winner);
    expect(forget).not.toHaveBeenCalled();
  });

  it("session 为空是 no-op", () => {
    const sessions = new Map<string, PersistentClaude>();
    dropStalePersistentSession("alice", sessions, undefined);
    expect(sessions.size).toBe(0);
  });
});

describe("dispatchHeadlessTurn 会话锁 / stale 清理 (P1.12)", () => {
  afterEach(() => {
    FakePersistentClaude.reset();
    delete process.env.SLOCK_ONESHOT_CLAUDE;
  });

  const makeOpts = (
    overrides: Partial<DispatchHeadlessTurnOpts> & {
      mintAgentCredential?: DispatchHeadlessTurnOpts["mintAgentCredential"];
    } = {},
  ): DispatchHeadlessTurnOpts => {
    const stateMachine = createAgentStateMachine();
    stateMachine.transitionState("alice", "idle");
    const persistentSessions = new Map<string, PersistentClaude>();
    return {
      agentName: "alice",
      agentId: "id-alice",
      channelName: "general",
      userMsg: "hello",
      haltGen: 0,
      serverUrl: "http://fake.test",
      stateMachine,
      idleReclaimer: createIdleReclaimer({ timeoutMs: Number.MAX_SAFE_INTEGER, onReclaim: () => {} }),
      mintAgentCredential: async () => "sk_agent_test",
      agentInfo: new Map(),
      persistentSessions,
      sessionCreates: new Map(),
      agentSessions: new Map(),
      turnGuards: new Map(),
      progressTurns: new Map(),
      handleStreamEvent: () => {},
      enterWorking: () => true,
      releaseToIdle: () => {},
      assertLive: () => {},
      forgetSessionCost: vi.fn(),
      ...overrides,
    };
  };

  it("mint 重叠的两次 dispatch 只 new 一个 PersistentClaude", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const opts = makeOpts({
      mintAgentCredential: async () => {
        await gate;
        return "sk_agent_test";
      },
    });

    const p1 = dispatchHeadlessTurn({ ...opts, userMsg: "m1" });
    const p2 = dispatchHeadlessTurn({ ...opts, userMsg: "m2" });
    await Promise.resolve();
    expect(FakePersistentClaude.instances).toHaveLength(0);

    release();
    await Promise.all([p1, p2]);

    expect(FakePersistentClaude.instances).toHaveLength(1);
    expect(opts.persistentSessions.size).toBe(1);
    expect(opts.persistentSessions.get("alice")).toBe(FakePersistentClaude.instances[0]);
    expect(FakePersistentClaude.instances[0]!.sent).toEqual(["m1", "m2"]);
  });

  it("send reject 后踢掉本实例；下一次 dispatch 换新会话", async () => {
    const forget = vi.fn();
    const opts = makeOpts({ forgetSessionCost: forget });

    FakePersistentClaude.defaultSendImpl = async () => {
      throw new Error("process died mid-turn");
    };
    await expect(dispatchHeadlessTurn({ ...opts, userMsg: "boom" })).rejects.toThrow(/mid-turn/);
    expect(FakePersistentClaude.instances).toHaveLength(1);
    expect(FakePersistentClaude.instances[0]!.stopped).toBe(true);
    expect(opts.persistentSessions.has("alice")).toBe(false);
    expect(forget).toHaveBeenCalledWith("alice");

    FakePersistentClaude.defaultSendImpl = undefined;
    await dispatchHeadlessTurn({ ...opts, userMsg: "retry" });
    expect(FakePersistentClaude.instances).toHaveLength(2);
    expect(opts.persistentSessions.get("alice")).toBe(FakePersistentClaude.instances[1]);
    expect(FakePersistentClaude.instances[1]!.sent).toEqual(["retry"]);
  });
});
