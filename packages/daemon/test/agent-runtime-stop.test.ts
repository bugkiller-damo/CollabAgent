import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime, type IAgentRuntime } from "../src/agent-runtime.js";
import { createAgentTokenRegistry } from "../src/agent-tokens.js";
import { createLiveRunRegistry } from "../src/live-run-registry.js";
import { createFakeAgentManager, type FakeAgentManager } from "./fakes/fake-agent-manager.js";
import { installFakeFetch } from "./fakes/fake-fetch.js";

/**
 * P0.3：stopAgent / stopAll / unregisterAgent 必须驱动状态机并清队列。
 * 用 fake PTY + 可控 fetch，不启真实 claude。
 */

const AGENT = "zz_stop_state_agent";
const AGENT_ID = randomUUID();
const OTHER = "zz_stop_state_other";
const OTHER_ID = randomUUID();

function installDeferredMint(): { release(): void; restore(): void } {
  const original = globalThis.fetch;
  let resolveMint!: () => void;
  const gate = new Promise<void>((r) => {
    resolveMint = r;
  });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/credentials") && method === "POST") {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "sk_agent_test_token", agentId: AGENT_ID, expiresAt: new Date().toISOString() }),
        text: async () => "",
      } as Response;
    }
    if (url.includes("/credentials") && method === "DELETE") {
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;
  return {
    release: () => resolveMint(),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("P0.3 stopAgent / stopAll / unregisterAgent state machine", () => {
  let fakeFetch: ReturnType<typeof installFakeFetch> | null = null;
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;

  const cleanupWorkspace = (name: string) => {
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

  beforeEach(() => {
    process.env.SLOCK_USE_PTY = "1";
    fakeFetch = installFakeFetch();
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
    delete process.env.SLOCK_USE_PTY;
    fakeFetch?.restore();
    fakeFetch = null;
    cleanupWorkspace(AGENT);
    cleanupWorkspace(OTHER);
    vi.restoreAllMocks();
  });

  it("register 后 stopAgent 落到 idle，仍保持注册", () => {
    runtime.registerAgent(AGENT_ID, AGENT, { displayName: "Stop Test" });
    expect(runtime.getAgentState(AGENT)).toBe("idle");
    runtime.stopAgent(AGENT);
    expect(runtime.getAgentState(AGENT)).toBe("idle");
    expect(runtime.hasAgent(AGENT)).toBe(true);
    expect(runtime.__getRunId(AGENT)).toBeNull();
  });

  it("unregisterAgent 落到 stopped 并摘掉注册", () => {
    runtime.registerAgent(AGENT_ID, AGENT, { displayName: "Stop Test" });
    runtime.unregisterAgent(AGENT);
    expect(runtime.getAgentState(AGENT)).toBe("stopped");
    expect(runtime.hasAgent(AGENT)).toBe(false);
  });

  it("working 时 stopAgent 回 idle 并杀掉进程（无幽灵 working）", async () => {
    runtime.registerAgent(AGENT_ID, AGENT, { displayName: "Stop Test" });
    await runtime.dispatchToAgent(AGENT, "general", "hello");
    expect(runtime.getAgentState(AGENT)).toBe("working");
    expect(runtime.__getRunId(AGENT)).toBeTruthy();

    runtime.stopAgent(AGENT);

    expect(runtime.getAgentState(AGENT)).toBe("idle");
    expect(runtime.__getRunId(AGENT)).toBeNull();
    expect(runtime.hasAgent(AGENT)).toBe(true);
  });

  it("stopAll 把已注册 agent 全部切到 stopped 并清进程", async () => {
    runtime.registerAgent(AGENT_ID, AGENT, { displayName: "A" });
    runtime.registerAgent(OTHER_ID, OTHER, { displayName: "B" });
    await runtime.dispatchToAgent(AGENT, "general", "hello");
    expect(runtime.getAgentState(AGENT)).toBe("working");

    runtime.stopAll();

    expect(runtime.getAgentState(AGENT)).toBe("stopped");
    expect(runtime.getAgentState(OTHER)).toBe("stopped");
    expect(runtime.__getRunId(AGENT)).toBeNull();
    expect(runtime.__getRunId(OTHER)).toBeNull();
  });

  it("stopAll 之后新消息不可投递（不复活 working）", async () => {
    runtime.registerAgent(AGENT_ID, AGENT, { displayName: "A" });
    runtime.stopAll();
    expect(runtime.getAgentState(AGENT)).toBe("stopped");

    await runtime.dispatchToAgent(AGENT, "general", "after-stop");
    expect(runtime.getAgentState(AGENT)).toBe("stopped");
    expect(runtime.__getRunId(AGENT)).toBeNull();
  });

  it("mint 进行中 stopAgent：完成后不进入 working，startupTimer 不把状态冲回", async () => {
    fakeFetch?.restore();
    fakeFetch = null;
    const deferred = installDeferredMint();
    runtime.registerAgent(AGENT_ID, AGENT, { displayName: "A" });

    const pending = runtime.dispatchToAgent(AGENT, "general", "during-mint");
    // 让 doDispatch 跑到 await mint
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.getAgentState(AGENT)).toBe("starting");

    runtime.stopAgent(AGENT);
    expect(runtime.getAgentState(AGENT)).toBe("idle");

    deferred.release();
    try {
      await pending;
      await new Promise((r) => setTimeout(r, 20));
      expect(runtime.getAgentState(AGENT)).toBe("idle");
      expect(runtime.__getRunId(AGENT)).toBeNull();
    } finally {
      deferred.restore();
    }
  });
});
