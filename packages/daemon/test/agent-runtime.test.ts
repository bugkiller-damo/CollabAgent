import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime, type IAgentRuntime } from "../src/agent-runtime.js";
import { createRuntimeInterruptStore } from "../src/agent-runtime-interrupt-store.js";
import { createLiveRunRegistry } from "../src/live-run-registry.js";
import { createFakeAgentManager, type FakeAgentManager } from "./fakes/fake-agent-manager.js";

/**
 * P0.8：agent-runtime 编排器单测（注册表 / mention 解析 / loadExistingAgents）。
 * stop 路径语义已由 agent-runtime-stop.test.ts（P0.3）覆盖，这里不重复。
 *
 * 全部走 headless 默认路径（不显式设 SLOCK_USE_PTY），注入 fake PTY manager
 * 双保险——headless 下它根本不会被用到。
 */

const A = "zz_rt_alice";
const A_ID = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "zz_rt_al";
const B_ID = "bbbbbbbb-2222-2222-2222-222222222222";

/** 可控的 /api/agents 响应；其余请求一律 200 空 JSON。 */
const installAgentsFetch = (handler: () => { ok: boolean; status?: number; body?: unknown }) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("/api/agents")) {
      const r = handler();
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        json: async () => r.body ?? {},
        text: async () => JSON.stringify(r.body ?? {}),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;
  return { restore: () => void (globalThis.fetch = original) };
};

describe("agent-runtime 注册表与 mention 解析", () => {
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    delete process.env.SLOCK_USE_PTY; // headless 默认路径
    manager = createFakeAgentManager();
    runtime = createAgentRuntime(
      { serverUrl: "http://fake-server.test", apiKey: "test-api-key" },
      createLiveRunRegistry(),
      undefined,
      manager,
    );
  });

  afterEach(() => {
    runtime.stopAll();
    vi.restoreAllMocks();
  });

  it("registerAgent 合并 info：重推缺省字段不抹掉已捕获的 model", () => {
    runtime.registerAgent(A_ID, A, { displayName: "Alice", model: "sonnet" });
    runtime.registerAgent(A_ID, A, { description: "新描述" });
    expect(runtime.getAgentInfo(A)).toEqual({ displayName: "Alice", description: "新描述", model: "sonnet" });
  });

  it("Phase 1：runtime/entrypoint 进 agentInfo；不带 profile 字段的重推保留它们", () => {
    runtime.registerAgent(A_ID, A, { runtime: "langgraph", entrypoint: "ep-1", runtimeProfileError: null });
    expect(runtime.getAgentInfo(A)).toMatchObject({ runtime: "langgraph", entrypoint: "ep-1" });
    runtime.registerAgent(A_ID, A, { description: "改描述" });
    expect(runtime.getAgentInfo(A)).toMatchObject({ runtime: "langgraph", entrypoint: "ep-1", description: "改描述" });
  });

  it("Phase 1：权威 profile 重推整体替换——切 runtime 不带 entrypoint 时清掉旧值", () => {
    runtime.registerAgent(A_ID, A, { runtime: "langgraph", entrypoint: "ep-1", runtimeProfileError: null });
    // PATCH 改回 claude：本次推送带 profile 字段（runtimeProfileError=null=无冲突）→ 权威合并
    runtime.registerAgent(A_ID, A, { runtime: "claude", runtimeProfileError: null });
    const info = runtime.getAgentInfo(A);
    expect(info?.runtime).toBe("claude");
    expect(info?.entrypoint).toBeUndefined(); // 旧 langgraph entrypoint 不残留
  });

  it("Phase 1：runtimeProfileError 随重推更新/清除", () => {
    const conflict = { code: "runtime-profile-conflict" as const, message: "conflict" };
    runtime.registerAgent(A_ID, A, { runtime: "claude", runtimeProfileError: conflict });
    expect(runtime.getAgentInfo(A)?.runtimeProfileError).toEqual(conflict);
    runtime.registerAgent(A_ID, A, { runtime: "claude", runtimeProfileError: null });
    expect(runtime.getAgentInfo(A)?.runtimeProfileError).toBeNull();
  });

  it("register 后状态为 idle；getAgentState 对未知 agent 返回 undefined", () => {
    expect(runtime.getAgentState(A)).toBeUndefined();
    runtime.registerAgent(A_ID, A, {});
    expect(runtime.getAgentState(A)).toBe("idle");
    expect(runtime.hasAgent(A)).toBe(true);
  });

  it("mentionedAgentNames 最长名优先且去重；findMentionedAgent 取首个", () => {
    runtime.registerAgent(A_ID, A, {});
    runtime.registerAgent(B_ID, B, {});
    // B(al) 是 A(alice) 的子串——长名优先避免 @zz_rt_alice 被 @zz_rt_al 抢先截胡
    expect(runtime.mentionedAgentNames(`@${A} 和 @${B} 来一下 @${A}`)).toEqual([A, B]);
    expect(runtime.findMentionedAgent(`@${A} 看下`)).toBe(A);
    expect(runtime.findMentionedAgent("没有人被提到")).toBeNull();
    expect(runtime.mentionedAgentNames("没有人被提到")).toEqual([]);
  });

  it("resolveAgentId：注册名查 id / UUID 直通 / 未知为 null", () => {
    runtime.registerAgent(A_ID, A, {});
    expect(runtime.resolveAgentId(A)).toBe(A_ID);
    expect(runtime.resolveAgentId("123e4567-e89b-42d3-a456-426614174000")).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(runtime.resolveAgentId("ghost")).toBeNull();
  });

  it("resolveAgentName：id 反查注册名；入参已是注册名则原样返回；未知为 null", () => {
    runtime.registerAgent(A_ID, A, {});
    expect(runtime.resolveAgentName(A_ID)).toBe(A);
    expect(runtime.resolveAgentName(A)).toBe(A);
    expect(runtime.resolveAgentName("cccccccc-3333-3333-3333-333333333333")).toBeNull();
  });

  it("listAgentNames 返回全部注册名；unregister 后移除", () => {
    runtime.registerAgent(A_ID, A, {});
    runtime.registerAgent(B_ID, B, {});
    expect(runtime.listAgentNames().sort()).toEqual([A, B].sort());
    runtime.unregisterAgent(B);
    expect(runtime.listAgentNames()).toEqual([A]);
    expect(runtime.getAgentState(B)).toBe("stopped");
  });
});

describe("agent-runtime loadExistingAgents", () => {
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;
  let fakeFetch: { restore(): void } | null = null;

  beforeEach(() => {
    delete process.env.SLOCK_USE_PTY;
    manager = createFakeAgentManager();
    runtime = createAgentRuntime(
      { serverUrl: "http://fake-server.test", apiKey: "test-api-key" },
      createLiveRunRegistry(),
      undefined,
      manager,
    );
  });

  afterEach(() => {
    runtime.stopAll();
    fakeFetch?.restore();
    fakeFetch = null;
    vi.restoreAllMocks();
  });

  it("注册值班 agent，跳过 duty=off", async () => {
    fakeFetch = installAgentsFetch(() => ({
      ok: true,
      body: {
        agents: [
          { id: A_ID, name: A, display_name: "Alice", description: "d", model: "sonnet", duty: "on" },
          { id: B_ID, name: B, duty: "off" },
        ],
      },
    }));
    await runtime.loadExistingAgents();
    expect(runtime.hasAgent(A)).toBe(true);
    expect(runtime.hasAgent(B)).toBe(false);
    expect(runtime.getAgentState(A)).toBe("idle");
    expect(runtime.getAgentInfo(A)).toEqual({ displayName: "Alice", description: "d", model: "sonnet" });
    expect(runtime.resolveAgentId(A)).toBe(A_ID);
  });

  it("Phase 1：runtime_profile.runtime/entrypoint 落进 agentInfo（重启不失忆）", async () => {
    fakeFetch = installAgentsFetch(() => ({
      ok: true,
      body: {
        agents: [
          {
            id: A_ID,
            name: A,
            duty: "on",
            runtime_profile: { runtime: "langgraph", model: "gpt-4o", entrypoint: "ep-1" },
          },
        ],
      },
    }));
    await runtime.loadExistingAgents();
    expect(runtime.getAgentInfo(A)).toMatchObject({ runtime: "langgraph", entrypoint: "ep-1" });
  });

  it("二次加载摘掉已下线/转 off-duty 的 agent", async () => {
    let body: unknown = { agents: [{ id: A_ID, name: A, duty: "on" }] };
    fakeFetch = installAgentsFetch(() => ({ ok: true, body }));
    await runtime.loadExistingAgents();
    expect(runtime.hasAgent(A)).toBe(true);

    body = { agents: [] }; // agent 被删除
    await runtime.loadExistingAgents();
    expect(runtime.hasAgent(A)).toBe(false);
    expect(runtime.getAgentState(A)).toBe("stopped");
  });

  it("非 2xx 显式失败但不清空既有注册（2026-08-24 静默丢注册回归）", async () => {
    fakeFetch = installAgentsFetch(() => ({ ok: true, body: { agents: [{ id: A_ID, name: A, duty: "on" }] } }));
    await runtime.loadExistingAgents();
    expect(runtime.hasAgent(A)).toBe(true);

    fakeFetch.restore();
    fakeFetch = installAgentsFetch(() => ({ ok: false, status: 500 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runtime.loadExistingAgents(); // 不抛出
    expect(runtime.hasAgent(A)).toBe(true); // 既有注册保留
    expect(errSpy).toHaveBeenCalled();
  });

  it("响应形状异常（agents 非数组）不注册也不抛出", async () => {
    fakeFetch = installAgentsFetch(() => ({ ok: true, body: { unexpected: true } }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runtime.loadExistingAgents();
    expect(runtime.listAgentNames()).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("WP11：cancelTurn（agent:cancel-turn 入口）", () => {
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    delete process.env.SLOCK_USE_PTY;
    manager = createFakeAgentManager();
    runtime = createAgentRuntime(
      { serverUrl: "http://fake-server.test", apiKey: "test-api-key" },
      createLiveRunRegistry(),
      undefined,
      manager,
    );
  });

  afterEach(() => {
    runtime.stopAll();
    vi.restoreAllMocks();
  });

  it("未知 agentId / 未注册名 → 'idle' no-op（不报错）", async () => {
    await expect(runtime.cancelTurn("cccccccc-3333-3333-3333-333333333333")).resolves.toBe("idle");
    await expect(runtime.cancelTurn("ghost")).resolves.toBe("idle");
  });

  it("已注册但无常驻会话 → 'idle' no-op（agent 空闲/从未 spawn）", async () => {
    runtime.registerAgent(A_ID, A, { runtime: "bridge", entrypoint: "ep-1" });
    await expect(runtime.cancelTurn(A_ID)).resolves.toBe("idle");
    // 注册名直通同一解析口径
    await expect(runtime.cancelTurn(A)).resolves.toBe("idle");
  });
});

describe("WP10：resolveInterrupt（interrupt:resolve 入口）", () => {
  const CONV = `slock:v1:${A_ID}:channel:general`;
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;
  let tmp: string;
  let interruptStore: ReturnType<typeof createRuntimeInterruptStore>;
  let onInterruptsChange: ReturnType<typeof vi.fn>;

  const putPending = (over?: Record<string, unknown>) =>
    interruptStore.put({
      agentId: A_ID,
      agentName: A,
      channel: "general",
      runtime: "bridge",
      entrypoint: "ep-1",
      conversationId: CONV,
      interruptId: "int-1",
      resumeToken: "tok-1",
      prompt: "批准执行吗？",
      options: { decisions: ["approve", "reject", "respond"] },
      kind: "message",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...over,
    });

  beforeEach(() => {
    delete process.env.SLOCK_USE_PTY;
    manager = createFakeAgentManager();
    tmp = mkdtempSync(join(tmpdir(), "slock-rt-"));
    interruptStore = createRuntimeInterruptStore(join(tmp, "interrupts.json"));
    onInterruptsChange = vi.fn();
    runtime = createAgentRuntime(
      {
        serverUrl: "http://fake-server.test",
        apiKey: "test-api-key",
        interruptStore,
        onInterruptsChange,
      },
      createLiveRunRegistry(),
      undefined,
      manager,
    );
    runtime.registerAgent(A_ID, A, { runtime: "bridge", entrypoint: "ep-1", runtimeProfileError: null });
  });

  afterEach(() => {
    runtime.stopAll();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("合法决定 → 按 pending 来源路由入队（approve 文本 + approver sender + resolve 锁）且不消费记录", async () => {
    putPending();
    const spy = vi.spyOn(runtime, "dispatchToAgent").mockResolvedValue(undefined);
    await runtime.resolveInterrupt(A_ID, CONV, "int-1", { type: "approve" }, "alice-h");
    expect(spy).toHaveBeenCalledWith(
      A,
      "general",
      "【审批】批准",
      undefined,
      "message",
      undefined,
      "alice-h",
      undefined,
      undefined,
      { conversationId: CONV, interruptId: "int-1", decision: { type: "approve" } },
    );
    // 只读校验不消费——投递时由 doDispatch take() 二次锁定（避免与入队间隔竞态丢中断）
    expect(interruptStore.list()).toHaveLength(1);
    expect(onInterruptsChange).not.toHaveBeenCalled(); // 记录未变 → 不推快照
  });

  it("reject/respond 生成可读 content，kind/channel/threadId 沿用 pending 记录", async () => {
    putPending({ threadId: "t-5", kind: "dispatch", conversationId: CONV });
    const spy = vi.spyOn(runtime, "dispatchToAgent").mockResolvedValue(undefined);
    await runtime.resolveInterrupt(A_ID, CONV, "int-1", { type: "reject", message: "先补测试" }, "alice-h");
    await runtime.resolveInterrupt(A_ID, CONV, "int-1", { type: "respond", message: "用 GET 就行" });
    expect(spy.mock.calls[0]).toEqual([
      A,
      "general",
      "【审批】拒绝：先补测试",
      "t-5",
      "dispatch",
      undefined,
      "alice-h",
      undefined,
      undefined,
      { conversationId: CONV, interruptId: "int-1", decision: { type: "reject", message: "先补测试" } },
    ]);
    expect(spy.mock.calls[1]![2]).toBe("【审批】回复：用 GET 就行");
    expect(spy.mock.calls[1]![6]).toBeUndefined(); // approver 缺省
    expect(spy).toHaveBeenCalledTimes(2); // 两条各自独立入队——不在本层去重
  });

  it("陈旧请求（记录缺失 / interruptId 顶替 / 决定未声明 / agentId 不符）→ warn + 重推快照，不入队不误删", async () => {
    putPending();
    const spy = vi.spyOn(runtime, "dispatchToAgent").mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runtime.resolveInterrupt(A_ID, "conv-ghost", "int-1", { type: "approve" });
    await runtime.resolveInterrupt(A_ID, CONV, "int-OLD", { type: "approve" }); // 被 int-1 顶替
    await runtime.resolveInterrupt(A_ID, CONV, "int-1", { type: "edit", args: {} }); // 未声明 edit
    await runtime.resolveInterrupt("cccccccc-3333-3333-3333-333333333333", CONV, "int-1", { type: "approve" });

    expect(spy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
    expect(onInterruptsChange).toHaveBeenCalledTimes(4); // 每条都重推快照收敛审批面
    expect(interruptStore.list().map((r) => r.interruptId)).toEqual(["int-1"]); // 原记录原样保留
  });

  it("过期 pending → 拒绝入队（投递层 take 也会惰性清除）", async () => {
    putPending({ expiresAt: Date.now() - 1 });
    const spy = vi.spyOn(runtime, "dispatchToAgent").mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runtime.resolveInterrupt(A_ID, CONV, "int-1", { type: "approve" });
    expect(spy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(onInterruptsChange).toHaveBeenCalledTimes(1);
  });

  it("pending 无 options 声明 → 任意合法决定放行", async () => {
    putPending({ options: undefined });
    const spy = vi.spyOn(runtime, "dispatchToAgent").mockResolvedValue(undefined);
    await runtime.resolveInterrupt(A_ID, CONV, "int-1", { type: "edit", args: { file: "a.ts" } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![9]).toMatchObject({ decision: { type: "edit", args: { file: "a.ts" } } });
  });
});
