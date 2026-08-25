import { describe, expect, it, vi } from "vitest";
import { createLazyAgentManager } from "../src/agent-manager-lazy.js";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createAgentTokenRegistry } from "../src/agent-tokens.js";
import { createLiveRunRegistry } from "../src/live-run-registry.js";
import type { IAgentManager } from "../src/types/index.js";
import { createFakeAgentManager } from "./fakes/fake-agent-manager.js";

/**
 * P0.7：headless 默认路径与 PTY 解耦。
 *
 * agent-manager.ts 顶层 import node-pty 原生模块；解耦前 createAgentRuntime
 * 无条件 createAgentManager()，headless 启动即加载原生依赖。解耦后真实
 * manager 只在第一次 startAgent（PTY fallback 真正 spawn）时动态 import。
 * 这里用注入的 loader 断言加载时机，不真正 import agent-manager.js——
 * 否则本测试进程自己就把 node-pty 加载了，断言失效。
 */

const lazyOf = (m: IAgentManager): { isLoaded(): boolean } => m as IAgentManager & { isLoaded(): boolean };

describe("createLazyAgentManager（P0.7 懒加载）", () => {
  it("同步方法在加载前是安全 no-op，不触发 loader", () => {
    const loader = vi.fn(async () => createFakeAgentManager() as IAgentManager);
    const m = createLazyAgentManager(loader);

    expect(m.isLoaded()).toBe(false);
    expect(m.getRun("r1")).toBeUndefined();
    m.stopRun("r1");
    m.writeInput("r1", "x");
    m.resizeRun("r1", 120, 40);
    m.pauseRun("r1");
    m.resumeRun("r1");
    m.removeRun("r1");
    // daemon-core 启动时 wireAgentOutput 会调 getOutputBus()——空 bus 也要可订阅
    expect(typeof m.getOutputBus().subscribe).toBe("function");
    expect(loader).not.toHaveBeenCalled();
    expect(m.isLoaded()).toBe(false);
  });

  it("startAgent 触发加载并委托；之后同步方法走真实 manager", async () => {
    const fake = createFakeAgentManager();
    const loader = vi.fn(async () => fake as IAgentManager);
    const m = createLazyAgentManager(loader);

    const snap = await m.startAgent({
      agentId: "a1",
      agentName: "claude",
      workspaceDir: ".",
      systemPromptFile: "p",
      env: {},
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(m.isLoaded()).toBe(true);
    expect(fake.getFakeRun(snap.runId)).toBeDefined();
    // 加载后 getRun / getOutputBus 委托真实 manager
    expect(m.getRun(snap.runId)?.runId).toBe(snap.runId);
    expect(m.getOutputBus()).toBe(fake.getOutputBus());
  });

  it("并发 startAgent 共享同一次加载", async () => {
    const fake = createFakeAgentManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loader = vi.fn(async () => {
      await gate;
      return fake as IAgentManager;
    });
    const m = createLazyAgentManager(loader);

    const p1 = m.startAgent({ agentId: "a1", agentName: "claude", workspaceDir: ".", systemPromptFile: "p", env: {} });
    const p2 = m.startAgent({ agentId: "a2", agentName: "claude", workspaceDir: ".", systemPromptFile: "p", env: {} });
    release();
    await Promise.all([p1, p2]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("加载失败不缓存 rejection——下次 startAgent 重试", async () => {
    const fake = createFakeAgentManager();
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("node-pty native module broken");
      return fake as IAgentManager;
    });
    const m = createLazyAgentManager(loader);

    await expect(
      m.startAgent({ agentId: "a1", agentName: "claude", workspaceDir: ".", systemPromptFile: "p", env: {} }),
    ).rejects.toThrow("node-pty native module broken");
    expect(m.isLoaded()).toBe(false);

    const snap = await m.startAgent({
      agentId: "a1",
      agentName: "claude",
      workspaceDir: ".",
      systemPromptFile: "p",
      env: {},
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(m.isLoaded()).toBe(true);
    expect(snap.runId).toBeTruthy();
  });

  it("默认 loader 在同步操作下不加载（headless 全程不引 node-pty）", () => {
    // 不注 loader——走真实的动态 import("./agent-manager.js")。只要不调
    // startAgent，isLoaded 必须保持 false（即 node-pty 从未被 import）。
    const m = createLazyAgentManager();
    m.getRun("x");
    m.getOutputBus();
    m.stopRun("x");
    expect(m.isLoaded()).toBe(false);
  });
});

describe("P0.7：headless runtime 生命周期不触发 PTY 加载", () => {
  it("register/stop/stopAll 后 manager 仍未加载", () => {
    // 不传 agentManagerOverride、不设 SLOCK_USE_PTY——生产 headless 默认形态
    const runtime = createAgentRuntime(
      { serverUrl: "http://fake-server.test", apiKey: "test-api-key" },
      createAgentTokenRegistry(),
      createLiveRunRegistry(),
    );
    try {
      const manager = lazyOf(runtime.__getAgentManager());
      expect(manager.isLoaded()).toBe(false);
      runtime.registerAgent("00000000-0000-0000-0000-0000000000a1", "zz_lazy_agent", {});
      runtime.stopAgent("zz_lazy_agent");
      runtime.unregisterAgent("zz_lazy_agent");
      expect(manager.isLoaded()).toBe(false);
    } finally {
      runtime.stopAll();
    }
  });
});
