import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonRunStore } from "../src/agent-run-store.js";
import { createAgentRuntime, type IAgentRuntime } from "../src/agent-runtime.js";
import { createAgentTokenRegistry } from "../src/agent-tokens.js";
import { createLiveRunRegistry } from "../src/live-run-registry.js";
import type { IAgentRunStore } from "../src/types/index.js";
import { createFakeAgentManager, type FakeAgentManager } from "./fakes/fake-agent-manager.js";
import { installFakeFetch } from "./fakes/fake-fetch.js";

/**
 * 方案三 §3.1（session resume）的回归测试。
 *
 * 2026-07-29 起**默认开启**（`SLOCK_SESSION_RESUME=0` 显式关闭时才退回旧行为）
 * ——冷启动全量 bootstrap + 上下文重建是 token 消耗大头，见
 * agent-runtime-spawn.ts 顶部注释。宽限期/重试逻辑用 fake-agent-manager 的
 * `simulateExit` 精确控制"PTY 很快退出"这个时序，钉死"resume 失败 -> 清空
 * sessionId -> 自动重试一次不带 --resume"这条兜底路径确实按设计工作。
 */

const AGENT_NAME = "zz_session_resume_agent";
const AGENT_ID = randomUUID();

describe("session resume (agent-runtime-spawn.ts, fake PTY)", () => {
  let fakeFetch: ReturnType<typeof installFakeFetch>;
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;
  let runStore: IAgentRunStore;
  let storePath: string;

  beforeEach(() => {
    delete process.env.SLOCK_SESSION_RESUME;
    // B2 起默认 headless；本文件钉的是 PTY 路径（fake PTY + --resume 链），显式钉回 PTY 模式
    process.env.SLOCK_USE_PTY = "1";
    // 生产环境的宽限期/捕获延迟是 3s/5s（见 agent-runtime-spawn.ts），测试里
    // 调小到几十毫秒——不是为了"测试更快"这种次要目标，是因为这两个真实定时
    // 器的等待时间一旦叠加多个测试，会在整套测试并发跑的时候占住 worker 太久，
    // 挤占了同时在跑的其它测试文件（比如 mcp-server.test.ts 真的 spawn 子进程
    // 那种时间敏感的测试）的调度窗口，导致它们偶发超时——这是实测过的真实现象
    // （单独跑 mcp-server.test.ts 稳定通过，加上这个文件一起跑就会超时），不是
    // 猜测。调小之后两边都稳定通过。
    process.env.SLOCK_RESUME_GRACE_MS = "80";
    process.env.SLOCK_SESSION_CAPTURE_DELAY_MS = "80";
    fakeFetch = installFakeFetch();
    manager = createFakeAgentManager();
    storePath = join(tmpdir(), `slock-session-resume-test-${randomUUID()}.json`);
    runStore = createJsonRunStore(storePath);
    runtime = createAgentRuntime(
      { serverUrl: "http://fake-server.test", apiKey: "test-api-key" },
      createAgentTokenRegistry(),
      createLiveRunRegistry(),
      runStore,
      manager,
    );
    runtime.registerAgent(AGENT_ID, AGENT_NAME, { displayName: "Session Resume Test" });
  });

  afterEach(() => {
    delete process.env.SLOCK_SESSION_RESUME;
    delete process.env.SLOCK_USE_PTY;
    delete process.env.SLOCK_RESUME_GRACE_MS;
    delete process.env.SLOCK_SESSION_CAPTURE_DELAY_MS;
    runtime.stopAll();
    fakeFetch.restore();
    try {
      rmSync(storePath, { force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(storePath + ".tmp", { force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(join(process.cwd(), ".slock", `sysprompt-${AGENT_NAME}.md`), { force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(join(process.cwd(), ".slock", "workspaces", AGENT_NAME), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** 轮询等到 fake manager 记录到一个新 run（见 fake-agent-manager.ts 对 lastCreatedRunId 的说明） */
  async function waitForNewRunId(excluding: Set<string>): Promise<string> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const id = manager.lastCreatedRunId;
      if (id && !excluding.has(id)) return id;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for a new fake run to be created");
  }

  it("does not inject --resume when SLOCK_SESSION_RESUME is explicitly '0', even with a saved session id", async () => {
    process.env.SLOCK_SESSION_RESUME = "0"; // 显式关闭（2026-07-29 起默认开启，见 spawn.ts isSessionResumeEnabled）
    runStore.saveRuntimeState({
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      status: "idle",
      lastTransitionAt: Date.now(),
      totalRuns: 1,
      currentRunId: null,
      lastSessionId: "seeded-session-id",
      lastSessionUpdatedAt: Date.now(),
    });

    await runtime.dispatchToAgent(AGENT_NAME, "general", "hello");
    const runId = runtime.__getRunId(AGENT_NAME);
    expect(runId).toBeTruthy();
    const run = manager.getFakeRun(runId!);
    expect(run?.args).toBeDefined();
    expect(run!.args.join(" ")).not.toContain("--resume");
  });

  it("injects --resume by default (SLOCK_SESSION_RESUME unset) when a session id is saved", async () => {
    runStore.saveRuntimeState({
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      status: "idle",
      lastTransitionAt: Date.now(),
      totalRuns: 1,
      currentRunId: null,
      lastSessionId: "seeded-session-id",
      lastSessionUpdatedAt: Date.now(),
    });

    await runtime.dispatchToAgent(AGENT_NAME, "general", "hello");
    const runId = runtime.__getRunId(AGENT_NAME);
    const run = manager.getFakeRun(runId!);
    expect(run!.args).toContain("--resume");
    expect(run!.args).toContain("seeded-session-id");
  });

  it("when enabled and the PTY survives the grace window: injects --resume <id> and skips the restart summary", async () => {
    process.env.SLOCK_SESSION_RESUME = "1";
    runStore.saveRuntimeState({
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      status: "idle",
      lastTransitionAt: Date.now(),
      totalRuns: 1,
      currentRunId: null,
      lastSessionId: "good-session-id",
      lastSessionUpdatedAt: Date.now(),
    });
    // 有历史 run 记录：如果没跳过 restart-summary 注入，bootstrap 文本里
    // 会带上"最近运行摘要"这类文字——用它来验证 didResume 真的抑制了这段注入。
    runStore.insertAgentRun({
      runId: "prior-run",
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      status: "exited",
      exitCode: 0,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 50_000,
      messagesProcessed: 3,
      lastTurnDuration: 1200,
    });

    await runtime.dispatchToAgent(AGENT_NAME, "general", "hello");
    const runId = runtime.__getRunId(AGENT_NAME);
    const run = manager.getFakeRun(runId!);
    expect(run!.args).toContain("--resume");
    expect(run!.args).toContain("good-session-id");

    // postStartWriter 要等屏幕上出现 ❯ 提示符才会真正写入（见
    // post-start-input-writer.ts），否则要等满 8s 超时兜底才会"硬写"——
    // 喂一帧带 ❯ 的屏幕内容，模拟 Claude Code 真实渲染出提示符。
    await run!.feed("\x1b[2J\x1b[H❯");
    await new Promise((r) => setTimeout(r, 1700));
    const bootstrapWrite = manager.writeInputCalls.find((c) => c.runId === runId);
    expect(bootstrapWrite).toBeTruthy();
    const text = String(bootstrapWrite!.input);
    expect(text).not.toContain("恢复摘要");
    expect(text).not.toContain("最近会话");
  }, 10_000);

  it("when enabled and the PTY exits quickly (simulated failed resume): clears the saved session id and retries once without --resume", async () => {
    process.env.SLOCK_SESSION_RESUME = "1";
    runStore.saveRuntimeState({
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      status: "idle",
      lastTransitionAt: Date.now(),
      totalRuns: 1,
      currentRunId: null,
      lastSessionId: "poisoned-session-id",
      lastSessionUpdatedAt: Date.now(),
    });

    const dispatchPromise = runtime.dispatchToAgent(AGENT_NAME, "general", "hello");
    const firstRunId = await waitForNewRunId(new Set());
    const firstRun = manager.getFakeRun(firstRunId)!;
    expect(firstRun.args).toContain("--resume");
    expect(firstRun.args).toContain("poisoned-session-id");

    // 模拟 --resume 带着一个坏掉的 session id 让 Claude Code 很快退出
    firstRun.simulateExit(1);

    // 宽限期检测到早退后会立即重试一次，产生第二个 fake run
    const secondRunId = await waitForNewRunId(new Set([firstRunId]));
    await dispatchPromise;

    expect(runtime.__getRunId(AGENT_NAME)).toBe(secondRunId);
    const secondRun = manager.getFakeRun(secondRunId)!;
    expect(secondRun.args.join(" ")).not.toContain("--resume");

    const state = runStore.loadRuntimeState(AGENT_ID);
    expect(state?.lastSessionId).toBeNull();
  }, 10_000);

  it("when the PTY dies AFTER the grace window (but before bootstrap is written): still recovers by redelivering via a fresh spawn, instead of silently writing into a dead run", async () => {
    // 2026-07-16 真机验证时实测到的真实场景：Claude Code 遇到坏 --resume
    // 并不总是在宽限期内就退出——这次模拟"宽限期已经过了、正常走到注册
    // 流程，但在 termsAcceptDone resolve 之前（bootstrap 真正写入之前）
    // PTY 才死掉"，钉死 agent-runtime-spawn.ts 里 bootstrap IIFE 那道
    // "isDead() 检测 + 重新 spawn 补投递"的兜底真的会被触发。
    process.env.SLOCK_SESSION_RESUME = "1";
    runStore.saveRuntimeState({
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      status: "idle",
      lastTransitionAt: Date.now(),
      totalRuns: 1,
      currentRunId: null,
      lastSessionId: "poisoned-session-id",
      lastSessionUpdatedAt: Date.now(),
    });

    const dispatchPromise = runtime.dispatchToAgent(AGENT_NAME, "general", "hello");
    const firstRunId = await waitForNewRunId(new Set());
    const firstRun = manager.getFakeRun(firstRunId)!;
    expect(firstRun.args).toContain("--resume");

    // 宽限期只有 80ms（这个文件的 beforeEach 里调小的），等它稳稳过去，
    // 让 attemptSpawn 走到"正常路径"（安装 termsAcceptDone 等），这次
    // *不* 在宽限期内杀掉它——模拟"resume 失败得比宽限期慢"这种情况。
    await new Promise((r) => setTimeout(r, 300));
    firstRun.simulateExit(1);

    // termsAcceptDone 真实要等 1.5s（agent-runtime-terms-dialog.ts 里硬编码，
    // 没有做成可配置——这个等待本身跟这次要验证的逻辑无关，如实反映生产延迟）
    // 才会 resolve，之后 bootstrap IIFE 里的 isDead() 检测才会跑到，触发重新
    // spawn；轮询等第二个 fake run 出现，比死等一个固定时长更稳。
    const secondRunId = await waitForNewRunId(new Set([firstRunId]));
    await dispatchPromise;

    expect(runtime.__getRunId(AGENT_NAME)).toBe(secondRunId);
    const secondRun = manager.getFakeRun(secondRunId)!;
    expect(secondRun.args.join(" ")).not.toContain("--resume");
    expect(runStore.loadRuntimeState(AGENT_ID)?.lastSessionId).toBeNull();

    // 补投递不是只换了个 runId 就完事——原来那条触发消息（"hello"）必须
    // 真的通过第二次 spawn 的 bootstrap 送达，不能销声匿迹。
    await secondRun.feed("\x1b[2J\x1b[H❯");
    await new Promise((r) => setTimeout(r, 1700));
    const bootstrapWrite = manager.writeInputCalls.find((c) => c.runId === secondRunId);
    expect(bootstrapWrite).toBeTruthy();
    expect(String(bootstrapWrite!.input)).toContain("hello");
  }, 10_000);
});
