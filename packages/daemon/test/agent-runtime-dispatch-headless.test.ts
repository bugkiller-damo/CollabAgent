import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P1.12：headless 会话创建单飞 + send 失败踢 stale session。
 */

const {
  FakePersistentClaude,
  fetchDispatchContextMock,
  writeSystemPromptFileMock,
  writeAgentTokenFileMock,
  createWorkspaceDirMock,
} = vi.hoisted(() => {
  class FakePersistentClaude {
    static instances: FakePersistentClaude[] = [];
    static defaultSendImpl?: (text: string) => Promise<void>;
    static reset(): void {
      FakePersistentClaude.instances = [];
      FakePersistentClaude.defaultSendImpl = undefined;
    }
    opts: any;
    sent: string[] = [];
    stopped = false;
    constructor(opts: unknown) {
      this.opts = opts;
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
  const fetchDispatchContextMock = vi.fn(async () => null as import("../src/agent-startup.js").DispatchContext | null);
  const writeSystemPromptFileMock = vi.fn(() => "prompt.md");
  const writeAgentTokenFileMock = vi.fn(() => "token-path");
  const createWorkspaceDirMock = vi.fn(() => "D:/tmp-p112");
  return {
    FakePersistentClaude,
    fetchDispatchContextMock,
    writeSystemPromptFileMock,
    writeAgentTokenFileMock,
    createWorkspaceDirMock,
  };
});

vi.mock("../src/drivers/persistent-claude.js", () => ({ PersistentClaude: FakePersistentClaude }));
vi.mock("../src/mcp-bundle.js", () => ({ bundleSlockMcpServer: async () => null }));
vi.mock("../src/agent-startup.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/agent-startup.js")>();
  return {
    ...actual,
    writeSystemPromptFile: writeSystemPromptFileMock,
    createWorkspaceDir: createWorkspaceDirMock,
    fetchDispatchContext: fetchDispatchContextMock,
  };
});
vi.mock("../src/agent-token-file.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/agent-token-file.js")>();
  return { ...actual, writeAgentTokenFile: writeAgentTokenFileMock };
});

import {
  type DispatchHeadlessTurnOpts,
  dispatchHeadlessTurn,
  dropStalePersistentSession,
  ensurePersistentSession,
} from "../src/agent-runtime-dispatch-headless.js";
import type { AgentRuntimeSession } from "../src/agent-runtime-driver.js";
import type { RuntimeManifestSnapshot } from "../src/agent-runtime-manifest.js";
import { resolveAgentRuntimeProfile } from "../src/agent-runtime-profile.js";
import { createAgentStateMachine } from "../src/agent-runtime-state.js";
import type { IAgentSessionStore } from "../src/agent-session-store.js";
import { createClaudeRuntimeDriver } from "../src/drivers/claude-runtime.js";
import { createIdleReclaimer } from "../src/idle-reclaimer.js";

/** 空 manifest：bridge entrypoint 不存在；claude 解析不消费它。 */
const EMPTY_MANIFEST: RuntimeManifestSnapshot = {
  path: "<test>",
  revision: "missing",
  entries: new Map(),
  invalidEntries: new Map(),
};

const fakeSession = (label: string) =>
  ({
    label,
    stop: vi.fn(),
  }) as unknown as AgentRuntimeSession & { label: string; stop: ReturnType<typeof vi.fn> };

describe("ensurePersistentSession (P1.12)", () => {
  it("已有会话直接返回，不调 create", async () => {
    const existing = fakeSession("a");
    const sessions = new Map<string, AgentRuntimeSession>([["alice", existing]]);
    const locks = new Map<string, Promise<AgentRuntimeSession>>();
    const create = vi.fn(() => fakeSession("b"));

    const got = await ensurePersistentSession("alice", sessions, locks, create);
    expect(got).toBe(existing);
    expect(create).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
  });

  it("同 tick 两次 ensure 只 create 一次，共用同一实例", async () => {
    const sessions = new Map<string, AgentRuntimeSession>();
    const locks = new Map<string, Promise<AgentRuntimeSession>>();
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
    const sessions = new Map<string, AgentRuntimeSession>();
    const locks = new Map<string, Promise<AgentRuntimeSession>>();
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
    const sessions = new Map<string, AgentRuntimeSession>([["alice", mine]]);
    const forget = vi.fn();

    dropStalePersistentSession("alice", sessions, mine, forget);
    expect(mine.stop).toHaveBeenCalledTimes(1);
    expect(sessions.has("alice")).toBe(false);
    expect(forget).toHaveBeenCalledWith("alice");
  });

  it("map 里已是别人的实例则不 stop、不 delete", () => {
    const mine = fakeSession("mine");
    const winner = fakeSession("winner");
    const sessions = new Map<string, AgentRuntimeSession>([["alice", winner]]);
    const forget = vi.fn();

    dropStalePersistentSession("alice", sessions, mine, forget);
    expect(mine.stop).not.toHaveBeenCalled();
    expect(winner.stop).not.toHaveBeenCalled();
    expect(sessions.get("alice")).toBe(winner);
    expect(forget).not.toHaveBeenCalled();
  });

  it("session 为空是 no-op", () => {
    const sessions = new Map<string, AgentRuntimeSession>();
    dropStalePersistentSession("alice", sessions, undefined);
    expect(sessions.size).toBe(0);
  });
});

describe("dispatchHeadlessTurn 会话锁 / stale 清理 (P1.12)", () => {
  afterEach(() => {
    FakePersistentClaude.reset();
    fetchDispatchContextMock.mockReset().mockResolvedValue(null);
    writeSystemPromptFileMock.mockClear();
    writeAgentTokenFileMock.mockClear();
    createWorkspaceDirMock.mockClear();
    delete process.env.SLOCK_ONESHOT_CLAUDE;
    delete process.env.SLOCK_SESSION_RESUME;
  });

  const makeOpts = (
    overrides: Partial<DispatchHeadlessTurnOpts> & {
      mintAgentCredential?: DispatchHeadlessTurnOpts["mintAgentCredential"];
    } = {},
  ): DispatchHeadlessTurnOpts => {
    const stateMachine = createAgentStateMachine();
    stateMachine.transitionState("alice", "idle");
    const persistentSessions = new Map<string, AgentRuntimeSession>();
    const agentInfo = overrides.agentInfo ?? new Map();
    return {
      agentName: "alice",
      agentId: "id-alice",
      channelName: "general",
      userMsg: "hello",
      haltGen: 0,
      serverUrl: "http://fake.test",
      apiKey: "test-key",
      stateMachine,
      idleReclaimer: createIdleReclaimer({ timeoutMs: Number.MAX_SAFE_INTEGER, onReclaim: () => {} }),
      mintAgentCredential: async () => "sk_agent_test",
      agentInfo,
      // Phase 2：回合元数据（§8.4）——测试缺省；用例可按需覆写 turn 字段
      turn: {
        turnId: "turn-test-1",
        conversationId: "slock:v1:id-alice:channel:general",
        attempt: 1,
      },
      // Phase 0：driver 边界——FakePersistentClaude 经 claude-runtime 适配器
      // 被 new 出来（vi.mock 照常拦截），保持实例身份断言不变。
      runtimeDriver: createClaudeRuntimeDriver(),
      // Phase 1：resolved profile——model 从 agentInfo 派生，与 doDispatch 一致
      runtimeProfile: resolveAgentRuntimeProfile(agentInfo.get("alice") ?? {}, EMPTY_MANIFEST),
      sessionIdentities: new Map(),
      persistentSessions,
      sessionCreates: new Map(),
      agentSessions: new Map(),
      credentialIssuedAt: new Map(),
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

  it("A1.1：agentInfo.model 传进 PersistentClaude opts（--model 由驱动拼参）", async () => {
    const opts = makeOpts({ agentInfo: new Map([["alice", { model: "haiku" }]]) });
    await dispatchHeadlessTurn(opts);
    expect(FakePersistentClaude.instances[0]!.opts.model).toBe("haiku");
  });

  it("A1.3：dispatchContext 进系统提示 + 回合语境行附角色/可派发名单", async () => {
    const ctx = { isManager: true, otherAgents: ["worker-a", "worker-b"] };
    fetchDispatchContextMock.mockResolvedValue(ctx);
    const opts = makeOpts();
    await dispatchHeadlessTurn(opts);

    // 系统提示拿到确定事实（A3 起 writeSystemPromptFile 去频道化，不再收 channelName）
    expect(fetchDispatchContextMock).toHaveBeenCalledWith("http://fake.test", "test-key", "id-alice", "general");
    expect(writeSystemPromptFileMock).toHaveBeenCalledWith("alice", true, {}, ctx);
    // 回合消息尾部附角色行（原始 userMsg 不被破坏）
    const sent = FakePersistentClaude.instances[0]!.sent[0]!;
    expect(sent).toContain("hello");
    expect(sent).toContain("【本回合语境】");
    expect(sent).toContain("经理");
    expect(sent).toContain("@worker-a");
    expect(sent).toContain("@worker-b");
  });

  it("A1.3：worker ctx 语境行声明非经理；DM 跳过 fetchDispatchContext", async () => {
    fetchDispatchContextMock.mockResolvedValue({ isManager: false, otherAgents: ["boss"] });
    const opts = makeOpts();
    await dispatchHeadlessTurn(opts);
    const sent = FakePersistentClaude.instances[0]!.sent[0]!;
    expect(sent).toContain("不是经理");

    fetchDispatchContextMock.mockClear();
    await dispatchHeadlessTurn(makeOpts({ channelName: "dm:@bob" }));
    expect(fetchDispatchContextMock).not.toHaveBeenCalled();
  });

  it("A2：store 的 sessionId 进 PersistentClaude.resumeSessionId；onResumeFailed 清 store", async () => {
    const SID = "67f1f0e9-aaaa-4bbb-8ccc-dddddddddddd";
    const store: IAgentSessionStore = {
      remember: vi.fn(() => null),
      lookup: vi.fn(() => ({ agentName: "alice", sessionId: SID, updatedAt: 1 })),
      forget: vi.fn(() => true),
      list: vi.fn(() => []),
    };
    const opts = makeOpts({ agentSessionStore: store });
    await dispatchHeadlessTurn(opts);

    const inst = FakePersistentClaude.instances[0]!;
    expect(store.lookup).toHaveBeenCalledWith("alice");
    expect(inst.opts.resumeSessionId).toBe(SID);

    // 驱动判 resume 失败（宽限期早退/首事件 error）→ 回调 → 清 store
    inst.opts.onResumeFailed?.(SID);
    expect(store.forget).toHaveBeenCalledWith("alice");

    // 但 store 里已是更新的 id 时不得盲删（例如新会话 init 已落盘）
    vi.mocked(store.forget).mockClear();
    inst.opts.onResumeFailed?.("cafef00d-1111-4222-8333-abcdefabcdef");
    expect(store.forget).not.toHaveBeenCalled();
  });

  it("A2：store 无记录 → resumeSessionId 为 undefined（全新会话）", async () => {
    const store: IAgentSessionStore = {
      remember: vi.fn(() => null),
      lookup: vi.fn(() => null),
      forget: vi.fn(() => false),
      list: vi.fn(() => []),
    };
    await dispatchHeadlessTurn(makeOpts({ agentSessionStore: store }));
    expect(FakePersistentClaude.instances[0]!.opts.resumeSessionId).toBeUndefined();
  });

  it("A2：SLOCK_SESSION_RESUME=0 时不查 store、不传 resumeSessionId", async () => {
    process.env.SLOCK_SESSION_RESUME = "0";
    const store: IAgentSessionStore = {
      remember: vi.fn(() => null),
      lookup: vi.fn(() => ({ agentName: "alice", sessionId: "67f1f0e9-aaaa-4bbb-8ccc-dddddddddddd", updatedAt: 1 })),
      forget: vi.fn(() => true),
      list: vi.fn(() => []),
    };
    await dispatchHeadlessTurn(makeOpts({ agentSessionStore: store }));
    expect(store.lookup).not.toHaveBeenCalled();
    expect(FakePersistentClaude.instances[0]!.opts.resumeSessionId).toBeUndefined();
  });

  it("A5：复用会话的回合不再 mint / 写 sysprompt / 建 workspace（验收：mint 0 次）", async () => {
    const mint = vi.fn(async () => "sk_agent_test");
    const opts = makeOpts({ mintAgentCredential: mint });

    await dispatchHeadlessTurn({ ...opts, userMsg: "first" });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(writeSystemPromptFileMock).toHaveBeenCalledTimes(1);
    expect(createWorkspaceDirMock).toHaveBeenCalledTimes(1);
    expect(writeAgentTokenFileMock).toHaveBeenCalledTimes(1);
    expect(opts.credentialIssuedAt.has("alice")).toBe(true);

    // 第二回合复用常驻会话：spawn-only 开销全部为零，只有 send
    await dispatchHeadlessTurn({ ...opts, userMsg: "second" });
    expect(FakePersistentClaude.instances).toHaveLength(1);
    expect(FakePersistentClaude.instances[0]!.sent).toEqual(["first", "second"]);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(writeSystemPromptFileMock).toHaveBeenCalledTimes(1);
    expect(createWorkspaceDirMock).toHaveBeenCalledTimes(1);
    expect(writeAgentTokenFileMock).toHaveBeenCalledTimes(1);
  });

  it("A5：scoped token 临期（>23h）复用时重 mint + 覆写 token 文件，不 respawn", async () => {
    const mint = vi.fn(async () => "sk_agent_test");
    const opts = makeOpts({ mintAgentCredential: mint });
    await dispatchHeadlessTurn({ ...opts, userMsg: "first" });
    expect(mint).toHaveBeenCalledTimes(1);

    // 把签发时间戳拨到 TTL(24h) - 余量(1h) 之外
    opts.credentialIssuedAt.set("alice", Date.now() - 24 * 60 * 60 * 1000);
    await dispatchHeadlessTurn({ ...opts, userMsg: "second" });

    // 重 mint + 覆写文件，但进程不换、sysprompt 不重写
    expect(mint).toHaveBeenCalledTimes(2);
    expect(writeAgentTokenFileMock).toHaveBeenCalledTimes(2);
    expect(FakePersistentClaude.instances).toHaveLength(1);
    expect(FakePersistentClaude.instances[0]!.sent).toEqual(["first", "second"]);
    expect(writeSystemPromptFileMock).toHaveBeenCalledTimes(1);
  });
});
