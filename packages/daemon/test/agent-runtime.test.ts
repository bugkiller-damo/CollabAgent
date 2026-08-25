import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime, type IAgentRuntime } from "../src/agent-runtime.js";
import { createAgentTokenRegistry } from "../src/agent-tokens.js";
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
      createAgentTokenRegistry(),
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
      createAgentTokenRegistry(),
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
