import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentRuntime, type IAgentRuntime } from "../src/agent-runtime.js";
import { createAgentTokenRegistry } from "../src/agent-tokens.js";
import { createLiveRunRegistry } from "../src/live-run-registry.js";
import { createFakeAgentManager, type FakeAgentManager } from "./fakes/fake-agent-manager.js";
import { installFakeFetch } from "./fakes/fake-fetch.js";

/**
 * `IAgentRuntime.autostartAgent()` 的回归测试（方案三 §3.2 autostart 方案 A）。
 * daemon-core.ts 本身（真实 WebSocket 连服务端）不适合在这一层测试，这里只
 * 测 autostartAgent 自己的两条分支：agent 还注册着就走完整 dispatch 流程
 * 拉起 PTY；agent 已经不在注册表里（崩溃后被删过）就安静跳过，不报错。
 */
const AGENT_NAME = "zz_autostart_agent";
const AGENT_ID = randomUUID();

describe("IAgentRuntime.autostartAgent", () => {
  let fakeFetch: ReturnType<typeof installFakeFetch>;
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    fakeFetch = installFakeFetch();
    manager = createFakeAgentManager();
    runtime = createAgentRuntime(
      { serverUrl: "http://fake-server.test", apiKey: "sk_machine_test" },
      createAgentTokenRegistry(),
      createLiveRunRegistry(),
      undefined,
      manager,
    );
  });

  afterEach(() => {
    runtime.stopAll();
    fakeFetch.restore();
    try {
      rmSync(join(process.cwd(), ".slock", `sysprompt-${AGENT_NAME}.md`), { force: true });
    } catch { /* best-effort */ }
    try {
      rmSync(join(process.cwd(), ".slock", "workspaces", AGENT_NAME), { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("spawns a PTY for a still-registered agent, without a real triggering user message", async () => {
    runtime.registerAgent(AGENT_ID, AGENT_NAME, { displayName: "Autostart Test" });

    await runtime.autostartAgent(AGENT_NAME);

    const runId = runtime.__getRunId(AGENT_NAME);
    expect(runId).toBeTruthy();
    expect(manager.getFakeRun(runId!)).toBeTruthy();
    expect(runtime.getAgentState(AGENT_NAME)).toBe("working");
  });

  it("is a silent no-op for an agent that is no longer registered (e.g. deleted server-side after a crash)", async () => {
    // 故意不调用 registerAgent——模拟 runStore 里有崩溃前的记录，但
    // loadExistingAgents() 从服务端拉回来的最新列表里已经没有这个 agent 了
    await expect(runtime.autostartAgent("zz_never_registered")).resolves.toBeUndefined();
    expect(runtime.__getRunId("zz_never_registered")).toBeNull();
    expect(manager.lastCreatedRunId).toBeNull();
  });
});
