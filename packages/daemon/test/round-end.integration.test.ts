import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentRuntime, type IAgentRuntime } from "../src/agent-runtime.js";
import { createAgentTokenRegistry } from "../src/agent-tokens.js";
import { createLiveRunRegistry } from "../src/live-run-registry.js";
import { createFakeAgentManager, type FakeAgentManager } from "./fakes/fake-agent-manager.js";
import { installFakeFetch } from "./fakes/fake-fetch.js";

/**
 * 集成测试：用假的 IAgentManager（真终端模拟器 + 假 PTY）驱动完整的
 * createAgentRuntime 调用链，把这次会话实际观测到的 bug 3/5/6/10/11 失败/成功
 * 样本当 fixture 钉成回归测试——不再需要每次改动都靠真人连续实机重测才能验证。
 *
 * 注意：termsAcceptDone（对话框检测窗口）用的是真实 setTimeout（1.5s），没有用
 * vitest 的 fake timers——这次先保证正确性，测试跑得慢一点可以接受；如果测试
 * 数量增多导致整体变慢，可以后续切换成 vi.useFakeTimers() 优化。
 */

const TEST_AGENT_NAME = "zz_test_round_end_agent";
const TEST_AGENT_ID = "11111111-1111-1111-1111-111111111111";

// 真实观测到的屏幕内容片段（来自这次会话实机联调的日志），直接当 fixture 用。
// 每一帧都以 "\x1b[2J\x1b[H"（清屏 + 光标归位）开头——真实的 Claude Code TUI
// 每次更新都是重绘整个屏幕，不是在光标当前位置追加文字；测试如果只是把新内容
// 接在上一帧后面，固定 24 行的可视区域里会同时残留新旧两帧的内容（比如上一帧
// 的 "esc to interrupt" 还留在屏幕上），跟真实终端行为不符，会污染断言。
const CLEAR_AND_HOME = "\x1b[2J\x1b[H";

/** 刚启动、还没处理任何消息时的空闲欢迎屏（bug 3/11 的误判来源） */
const SPLASH_SCREEN =
  CLEAR_AND_HOME +
  [
    "▐▛███▜▌ Claude Code v2.1.211",
    "▝▜█████▛▘ Sonnet 5 · API Usage Billing",
    "────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────",
    "⏵⏵ bypass permissions on (shift+tab to cycle)  ctrl+g to edit in Notepad.exe",
  ].join("\r\n");

/** 正在处理中的忙碌帧（bug 5/6 的误判来源——带 ❯ 边框，但底部是 esc to interrupt） */
const BUSY_FRAME =
  CLEAR_AND_HOME +
  [
    "✻ Philosophising…",
    "────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────",
    "⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for ag…",
  ].join("\r\n");

/** bug 10 的确切复现字节：❯ 紧跟在文字后面，没有换行分隔的"紧凑收尾帧" */
const COMPACT_DONE_FRAME = CLEAR_AND_HOME + "✻Cooked for2m 42s❯ ← for agents";

describe("agent-runtime round-end detection (integration, fake PTY)", () => {
  let fakeFetch: ReturnType<typeof installFakeFetch>;
  let manager: FakeAgentManager;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    // B2 起默认 headless；本文件钉的是 PTY 路径（fake PTY + 屏幕启发式回合检测），显式钉回 PTY 模式
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
    runtime.registerAgent(TEST_AGENT_ID, TEST_AGENT_NAME, { displayName: "Test Agent" });
  });

  afterEach(() => {
    delete process.env.SLOCK_USE_PTY;
    runtime.stopAll();
    fakeFetch.restore();
  });

  afterAll(() => {
    // 清理 writeSystemPromptFile/createWorkspaceDir 在 process.cwd()/.slock 下
    // 真实写入的测试产物（.slock 本身已 gitignore，这里只是保持本地目录干净）
    const dir = join(process.cwd(), ".slock");
    try {
      rmSync(join(dir, `sysprompt-${TEST_AGENT_NAME}.md`), { force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(join(dir, "workspaces", TEST_AGENT_NAME), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  async function dispatchAndGetRun() {
    await runtime.dispatchToAgent(TEST_AGENT_NAME, "general", "你好");
    const runId = runtime.__getRunId(TEST_AGENT_NAME);
    expect(runId).toBeTruthy();
    const run = manager.getFakeRun(runId!);
    expect(run).toBeTruthy();
    return run!;
  }

  /** 等 termsAcceptDone 的 1.5s 无对话框超时窗口 + 一点余量，确保 incPending 已经跑过 */
  async function waitForPendingToBeSet() {
    await new Promise((resolve) => setTimeout(resolve, 1700));
  }

  it("does not fire round-end on the pristine startup splash, even after it becomes pending (bug 3 / bug 11 regression)", async () => {
    const run = await dispatchAndGetRun();
    await run.feed(SPLASH_SCREEN);
    await waitForPendingToBeSet();

    // 再喂一次同样的欢迎屏内容，模拟"这一帧恰好又被重新渲染了一次"——
    // 此时 pending 已经是 true，但从没观测到过忙碌标记，round-end 不应该触发
    await run.feed(SPLASH_SCREEN);
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");
  }, 10000);

  it("does not fire round-end while a busy marker is showing, even though the ❯ box is also rendered (bug 5/6 regression)", async () => {
    const run = await dispatchAndGetRun();
    await run.feed(SPLASH_SCREEN);
    await waitForPendingToBeSet();

    await run.feed(BUSY_FRAME);
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");
  }, 10000);

  it("fires round-end on a compact no-newline completion frame, once busy was observed first (bug 10 fix + bug 11 invariant)", async () => {
    const run = await dispatchAndGetRun();
    await run.feed(SPLASH_SCREEN);
    await waitForPendingToBeSet();

    await run.feed(BUSY_FRAME);
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");

    await run.feed(COMPACT_DONE_FRAME);
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("idle");
  }, 10000);

  it("never fires round-end if busy was never observed, even after many idle-looking frames (bug 11 core invariant)", async () => {
    const run = await dispatchAndGetRun();
    await run.feed(SPLASH_SCREEN);
    await waitForPendingToBeSet();

    // 连续喂好几次"看起来空闲"的帧，但从没出现过忙碌标记——
    // 这正是 bug 11 的失败场景：不能仅凭"当前空闲"就判定回合结束
    for (let i = 0; i < 3; i++) {
      await run.feed(SPLASH_SCREEN);
      expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");
    }
  }, 10000);

  it("keeps waiting through an overlapping second dispatch instead of resetting on arrival (bug 8 regression)", async () => {
    const run = await dispatchAndGetRun();
    await run.feed(SPLASH_SCREEN);
    await waitForPendingToBeSet();

    await run.feed(BUSY_FRAME);
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");

    // 第二条消息在第一条还"忙碌中"时到达——复用同一个已运行的 PTY
    // （runIdByAgent 已经有这个 agent 的 runId，走 doDispatch 的复用分支）
    await runtime.dispatchToAgent(TEST_AGENT_NAME, "general", "第二条消息");
    // 不应该因为第二条消息的到来就重置"已经观测到忙碌"这个证据
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");

    // 只有等两条消息都处理完（真正回到空闲）才应该触发 round-end
    await run.feed(COMPACT_DONE_FRAME);
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("idle");
  }, 10000);

  it("does not leak stale pending/busy state into a fresh spawn after the previous run exited (bug 9 regression)", async () => {
    const run1 = await dispatchAndGetRun();
    await run1.feed(SPLASH_SCREEN);
    await waitForPendingToBeSet();
    await run1.feed(BUSY_FRAME); // 忙碌中，pending 还没被消费
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");

    // 模拟这个 run 被杀掉（比如 idle-reclaimer 误杀，或者进程崩溃）——
    // pending/busyObserved 都应该在退出清理链里被清空
    run1.simulateExit(1);
    // 退出清理链会把状态转回 idle（不是 stopped，见 agent-runtime.ts 的注释）
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("idle");

    // 重新 dispatch，全新 spawn 一个 PTY；如果 pending/busyObserved 没有正确清理，
    // 这里喂一次干净的欢迎屏就会立刻被误判成"回合结束"（复现过 bug 3/9 的症状）
    await runtime.dispatchToAgent(TEST_AGENT_NAME, "general", "重新触发");
    const runId2 = runtime.__getRunId(TEST_AGENT_NAME);
    expect(runId2).toBeTruthy();
    expect(runId2).not.toBe(run1.runId);
    const run2 = manager.getFakeRun(runId2!)!;
    await run2.feed(SPLASH_SCREEN);
    await waitForPendingToBeSet();
    await run2.feed(SPLASH_SCREEN); // 再喂一次，模拟"这一帧又被重绘了一次"
    expect(runtime.getAgentState(TEST_AGENT_NAME)).toBe("working");
  }, 10000);
});
