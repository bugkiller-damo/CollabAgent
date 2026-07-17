# 方案一：daemon 自动化测试补齐

**日期**: 2026-07-16
**优先级**: 最高——建议第一个做
**目标文件**: 新增 `packages/daemon/test/fakes/fake-agent-manager.ts`、`test/round-end.test.ts`、`test/post-start-input-writer.test.ts` 等

---

## 问题

`packages/daemon/test/` 现在只有 3 个测试文件（`agent-tokens.test.ts`/`live-run-registry.test.ts`/`command-presets.test.ts`），测的都是孤立的小模块。真正出过 12 次真实 bug 的地方——`agent-runtime.ts`（1011 行，回合结束检测/状态机/token 换取/消息分发全在一个文件里的一堆闭包）、`post-start-input-writer.ts`、`terminal-state.ts`——**一行自动化测试都没有**。这次会话踩的坑，全部靠人工连续实机重测才发现。这个状况不解决，下次 Claude Code 版本更新导致 UI 渲染方式再变，还是要走"实测→贴日志→猜→改→再实测"这个循环。

---

## 方案

### 第一层：纯函数测试（成本最低，立刻能做）

`post-start-input-writer.ts` 里 `hasInteractivePromptReady`/`hasPasteAck` 已经是纯函数（输入 `screenText` 字符串，输出布尔值），可以直接写表驱动测试，把这次会话里实际遇到的失败样本当测试夹具（fixture）钉死，防止回归：

```ts
// test/post-start-input-writer.test.ts
import { describe, it, expect } from "vitest";
import { hasInteractivePromptReady, hasPasteAck } from "../src/post-start-input-writer.js";

describe("hasInteractivePromptReady", () => {
  it("detects standard boxed prompt", () => {
    expect(hasInteractivePromptReady("──── ❯ ────")).toBe(true);
  });
  it("detects compact no-newline completion frame (bug 10 repro)", () => {
    expect(hasInteractivePromptReady("✻Cooked for2m 42s❯ ← for agents")).toBe(true);
  });
  it("returns false on splash screen with no prompt at all", () => {
    expect(hasInteractivePromptReady("Claude Code v2.1.211")).toBe(false);
  });
});
```

同样把 `BUSY_MARKER_RE`/`PROMPT_RE`（目前是 `agent-runtime.ts` 里的模块级常量，未导出）导出，单独测一遍"忙碌帧 vs 空闲帧"的判断——这个改动只是加 `export`，不影响现有逻辑。

### 第二层：Fake PTY 集成测试（核心价值所在）

`IAgentManager`/`AgentRunSnapshot` 接口已经很干净（`types/index.ts`），可以写一个**假的 `IAgentManager` 实现**：不需要真的 spawn 子进程，内部用真正的 `createTerminalState()`（`terminal-state.ts` 只依赖 `@xterm/headless`，不依赖真实 PTY）去获得跟生产环境一致的 `screenText` 行为，`writeInput`/`startAgent` 等方法只是操作内存状态。

```ts
// test/fakes/fake-agent-manager.ts
import { createTerminalState } from "../../src/terminal-state.js";
import type { IAgentManager, AgentRunSnapshot, StartAgentInput, PtyOutputBus } from "../../src/types/index.js";
import { createPtyOutputBus } from "../../src/pty-output-bus.js";

export interface FakeRun {
  runId: string;
  terminal: ReturnType<typeof createTerminalState>;
  status: "running" | "exited" | "error";
  exitCode: number | null;
  /** 测试驱动用：往这个 run 的"终端"里喂一段字节，模拟 Claude 的输出 */
  feed(data: string): Promise<void>;
}

export function createFakeAgentManager(): IAgentManager & { runs: Map<string, FakeRun>; getFakeRun(runId: string): FakeRun } {
  const runs = new Map<string, FakeRun>();
  const outputBus: PtyOutputBus = createPtyOutputBus();
  let counter = 0;

  return {
    runs,
    getFakeRun: (runId) => runs.get(runId)!,
    async startAgent(input: StartAgentInput): Promise<AgentRunSnapshot> {
      const runId = `fake-run-${counter++}`;
      const terminal = createTerminalState(input.cols ?? 80, input.rows ?? 24);
      const run: FakeRun = {
        runId, terminal, status: "running", exitCode: null,
        feed: (data) => new Promise((resolve) => terminal.write(data, () => {
          outputBus.publish({ runId, data, timestamp: Date.now() });
          resolve();
        })),
      };
      runs.set(runId, run);
      // 立刻调用 onExit 挂钩测试需要时（比如模拟崩溃）单独调用，这里先不触发
      (input as any)._onExitHook = input.onExit; // 供测试手动触发退出
      return { runId, agentId: input.agentId, pid: 1, status: "running", exitCode: null, output: "", screenText: terminal.getScreenText(), cols: 80, rows: 24, startedAt: Date.now() };
    },
    stopRun(runId) { const r = runs.get(runId); if (r) r.status = "exited"; },
    writeInput(runId, input) {
      // 测试里可以在这里捕获"agent 实际收到了什么输入"，用于断言 postStartWriter 写对了内容
    },
    resizeRun() {},
    pauseRun() {},
    resumeRun() {},
    getRun(runId): AgentRunSnapshot | undefined {
      const r = runs.get(runId);
      if (!r) return undefined;
      return { runId, agentId: "", pid: 1, status: r.status, exitCode: r.exitCode, output: "", screenText: r.terminal.getScreenText(), cols: 80, rows: 24, startedAt: 0 };
    },
    getOutputBus: () => outputBus,
    removeRun(runId) { runs.get(runId)?.terminal.dispose(); runs.delete(runId); outputBus.clear(runId); },
  };
}
```

（上面是设计草图，实现时要对齐 `types/index.ts` 当前的精确字段——写的时候直接读一遍接口定义。）

### 用这个 fake manager 写回归测试，把这次的 12 个 bug 逐一钉死

```ts
// test/round-end.test.ts（示意，实际要接入 createAgentRuntime 的构造方式）
it("does NOT fire round-end on the pristine startup splash (bug 3 / bug 11 regression)", async () => {
  const manager = createFakeAgentManager();
  // ... 用 manager 构造 runtime，触发 spawn ...
  await run.feed(SPLASH_SCREEN_FIXTURE); // 真实 bug 11 复现时抓到的欢迎屏字节
  expect(runtime.getAgentState("agent1")).toBe("working"); // 不应该提前变 idle
});

it("fires round-end only after busy->idle transition (bug 11 fix)", async () => {
  await run.feed(BUSY_FRAME_FIXTURE);   // 带 "esc to interrupt"
  await run.feed(COMPACT_DONE_FRAME_FIXTURE); // bug 10 的 "Cooked for2m 42s❯ ← for agents"
  expect(runtime.getAgentState("agent1")).toBe("idle");
});

it("keeps waiting when a second message arrives mid-turn (bug 8/9 regression)", async () => {
  // dispatch 两次，第一次 busy，第二次到达时不应该重置基线
});
```

这次会话每个 bug 的**实际观测字节**（用户贴的日志片段）都可以直接抄成 fixture 常量——这些不是凭空构造的测试数据，是真实复现过的失败样本，比自己瞎编的测试用例更有价值。

### 第三层（可选，量力而行）：`doDispatch` 端到端流程测试

用同一个 fake manager，测完整的"首次 dispatch → spawn → bootstrap 写入 → 第二次 dispatch → 复用 PTY"流程，覆盖 `hasPending`/`busyObservedByAgent`/`roundStartOffsetByRun`（已移除）这些跨 dispatch 的状态是否正确维护。这一层工作量最大，可以放在第二层稳定之后再补。

---

## 实施顺序建议

1. 导出 `BUSY_MARKER_RE`/`PROMPT_RE`，加纯函数测试（1 小时量级）
2. 写 `fake-agent-manager.ts`（半天量级，要花时间对齐 `IAgentManager` 接口的精确行为）
3. 用真实 bug 3/5/6/8/9/10/11 的观测数据当 fixture，写回归测试（有了 fake manager 之后，每个 bug 大概 20-30 分钟能写一个）
4. （可选）端到端 `doDispatch` 流程测试

## 和其他方案的关系

- 如果先做「方案四：`agent-runtime.ts` 拆分」，这里的纯函数会更容易独立测试（不需要整个 fake manager 才能测到 `BUSY_MARKER_RE`/`PROMPT_RE` 这类逻辑）。但**不建议**为了"测试更好写"而先拆分——拆分本身有引入新 bug 的风险，应该先有测试兜底再拆，不是反过来。

---

## 执行记录（2026-07-16 当天完成）

### 需要的最小改动

- `agent-runtime.ts`：`BUSY_MARKER_RE`/`PROMPT_RE` 加 `export`。
- `post-start-input-writer.ts`：`commandBaseName` 加 `export`（这次拿它直接测第 12 个 bug 的回归）。
- `createAgentRuntime` 新增第 5 个可选参数 `agentManagerOverride?: IAgentManager`——之前 `agentManager` 是内部用 `createAgentManager()` 硬编码构造的，测试没法注入假实现。改成 `agentManagerOverride ?? createAgentManager()`，生产环境不传这个参数，行为完全不变（纯加法，`tsc`/现有调用点都没受影响）。

### 三层测试全部落地

1. **纯函数层**：`test/post-start-input-writer.test.ts`（`hasInteractivePromptReady`/`hasPasteAck`/`commandBaseName`/`toBracketedPasteSubmission`，20 个用例）+ `test/round-end-detection.test.ts`（`BUSY_MARKER_RE`/`PROMPT_RE`，7 个用例）。
2. **Fake PTY 集成层**：新增 `test/fakes/fake-agent-manager.ts`（用真正的 `createTerminalState()`，只是不接真实子进程）+ `test/fakes/fake-fetch.ts`（拦截 `mintAgentCredential`/`revokeAgentCredential` 的 HTTP 调用）+ `test/round-end.integration.test.ts`，6 个回归测试全部用这次会话实机观测到的真实屏幕字节做 fixture：
   - bug 3/11：欢迎屏 + pending=true 之后，没观测到过忙碌，不应该判定回合结束
   - bug 5/6：忙碌帧（带 ❯ 边框 + esc to interrupt）不应该判定回合结束
   - bug 10：忙碌之后接一个不带换行的"紧凑收尾帧"（`Cooked for2m 42s❯ ← for agents`）应该正确判定回合结束
   - bug 8：第二条消息在第一条还忙碌时到达，不应该重置"已观测到忙碌"这个证据
   - bug 9：run 被杀（`simulateExit`）之后，pending/busyObserved 不应该带着陈年状态漏进下一次全新 spawn

### 踩的一个坑（写测试时才发现，不是生产代码的 bug）

第一版的 `COMPACT_DONE_FRAME` fixture 直接拼在 `BUSY_FRAME` 后面喂给假终端，测试断言"应该变成 idle"失败了——排查发现是**测试 fixture 本身不对**：真实的 Claude Code TUI 每次更新都是整屏重绘，而不是在光标当前位置追加文字；fixture 没有先发一个清屏指令（`\x1b[2J\x1b[H`），导致固定 24 行的可视区域里同时残留着上一帧的 "esc to interrupt"，`BUSY_MARKER_RE` 一直命中，永远到不了判定"回合结束"的分支。这不是生产逻辑的 bug（生产环境里 Claude Code 自己会正确清屏重绘），是测试模拟真实终端行为时必须还原这个细节，修了 fixture（每帧前面加清屏指令）后测试全部通过——这也顺带验证了一个重要的事实：`agent-runtime.ts` 的回合结束检测**依赖 Claude Code 自己会正确清屏重绘**这个假设，如果未来遇到某个版本/场景不这样清屏，可能会重新触发类似 bug 11 的问题（值得记一笔，作为这条检测路线仍然存在的脆弱性）。

### 验证结果

`packages/daemon` 测试从 3 个文件 36 个用例，变成 **6 个文件 62 个用例**，全部通过；`tsc --noEmit` 干净（测试文件本身不在 `tsconfig.json` 的 `include` 范围内，跟现有 3 个测试文件的约定一致，只由 vitest 自己的 esbuild transform 处理）。整个套件跑完约 13 秒（主要是 `termsAcceptDone` 的 1.5s 真实定时器 × 多个测试用例累加的），可以接受；如果之后测试数量继续增多导致整体变慢，可以考虑切到 `vi.useFakeTimers()` 优化，这次先保证正确性。

### 未覆盖、留给后续的部分

- `doDispatch` 的 `PersistentClaude`/`claudePrint` 兜底路径（`usePty=false` 时）没有测试——这条路径本身在这次会话里也没有被实机验证过，优先级较低。
- `installTermsAcceptHandler` 的对话框检测分支（真的检测到 Accept-Permissions 对话框并发送 "2"+回车）没有单独测试——可以后续加一个 fixture 覆盖。
- Autostart/session resume（方案三）还没做，等做的时候需要为对应新逻辑单独补测试。
