import { createTerminalState, type ITerminalState } from "../../src/terminal-state.js";
import { createPtyOutputBus } from "../../src/pty-output-bus.js";
import type {
  IAgentManager,
  AgentRunSnapshot,
  StartAgentInput,
  PtyOutputBus,
  RunStatus,
} from "../../src/types/index.js";

/**
 * 假的 IAgentManager，用于在不启动真实子进程的情况下测试 agent-runtime.ts。
 *
 * 用真正的 `createTerminalState()`（`@xterm/headless`）而不是自己模拟屏幕状态——
 * 这样 `feed()` 喂进去的 ANSI 字节会被同一套终端模拟器正确解析，测试断言的
 * `screenText` 跟生产环境的行为一致，不是凭空构造的假数据。
 */
export interface FakeRun {
  runId: string;
  agentId: string;
  status: RunStatus;
  exitCode: number | null;
  output: string;
  terminal: ITerminalState;
  cols: number;
  rows: number;
  startedAt: number;
  /** 这次 startAgent 调用时传入的 args（测试断言用：比如验证 --resume 有没有被正确注入/移除） */
  args: string[];
  onExit?: (runId: string, exitCode: number | null) => void;
  /** 喂一段 PTY 字节；resolve 时终端缓冲区已经反映这段数据（跟生产环境
   *  agent-manager-support.ts 的 write-with-callback 保证一致） */
  feed(data: string): Promise<void>;
  /** 模拟进程退出（触发 startAgent 时注册的 onExit 回调） */
  simulateExit(exitCode: number | null): void;
}

export interface FakeAgentManager extends IAgentManager {
  /** 测试断言用：拿到某个 run 的完整状态（包括 feed/simulateExit 等测试专用方法） */
  getFakeRun(runId: string): FakeRun | undefined;
  /** 测试断言用：捕获每一次 writeInput 调用，方便断言"到底写了什么" */
  writeInputCalls: Array<{ runId: string; input: string | Buffer }>;
  /**
   * 最近一次 startAgent() 创建的 runId——startAgent 的假实现内部没有真正的
   * await，`runs.set(runId, run)` 在调用方拿到 resolve 之前就已经同步跑完了，
   * 所以测试可以在调用方的 await 还没结束时就轮询这个字段拿到 runId，抢在
   * spawn 内部的宽限期计时器跑完之前调用 `getFakeRun(runId).simulateExit(...)`
   * 模拟"resume 参数导致 PTY 很快退出"这类时序敏感场景。
   */
  lastCreatedRunId: string | null;
}

export function createFakeAgentManager(): FakeAgentManager {
  const runs = new Map<string, FakeRun>();
  const outputBus: PtyOutputBus = createPtyOutputBus();
  const writeInputCalls: FakeAgentManager["writeInputCalls"] = [];
  let counter = 0;

  const toSnapshot = (run: FakeRun): AgentRunSnapshot => ({
    runId: run.runId,
    agentId: run.agentId,
    pid: 1,
    status: run.status,
    exitCode: run.exitCode,
    output: run.output,
    screenText: run.terminal.getScreenText(),
    historyText: run.terminal.getHistoryText(400),
    cols: run.cols,
    rows: run.rows,
    startedAt: run.startedAt,
  });

  const manager: FakeAgentManager = {
    writeInputCalls,
    lastCreatedRunId: null,

    async startAgent(input: StartAgentInput): Promise<AgentRunSnapshot> {
      const runId = `fake-run-${++counter}`;
      const cols = input.cols ?? 80;
      const rows = input.rows ?? 24;
      const terminal = createTerminalState(cols, rows);

      const run: FakeRun = {
        runId,
        agentId: input.agentId,
        status: "running",
        exitCode: null,
        output: "",
        terminal,
        cols,
        rows,
        startedAt: Date.now(),
        args: input.args ?? [],
        onExit: input.onExit,
        feed(data: string): Promise<void> {
          run.output += data;
          return new Promise((resolve) => {
            terminal.write(data, () => {
              outputBus.publish({ runId, data, timestamp: Date.now() });
              resolve();
            });
          });
        },
        simulateExit(exitCode: number | null): void {
          run.status = exitCode === 0 ? "exited" : "error";
          run.exitCode = exitCode;
          run.onExit?.(runId, exitCode);
        },
      };
      runs.set(runId, run);
      manager.lastCreatedRunId = runId;
      return toSnapshot(run);
    },

    stopRun(runId: string): void {
      const run = runs.get(runId);
      if (!run) return;
      run.simulateExit(0);
    },

    writeInput(runId: string, input: string | Buffer): void {
      writeInputCalls.push({ runId, input });
      // 假 manager 不会自动回显——测试要自己决定"写入之后 Claude 会说什么"，
      // 用 getFakeRun(runId).feed(...) 手动推进
    },

    resizeRun(runId: string, cols: number, rows: number): void {
      const run = runs.get(runId);
      if (!run) return;
      run.cols = cols;
      run.rows = rows;
      run.terminal.resize(cols, rows);
    },

    pauseRun(): void {},
    resumeRun(): void {},

    getRun(runId: string): AgentRunSnapshot | undefined {
      const run = runs.get(runId);
      return run ? toSnapshot(run) : undefined;
    },

    getOutputBus: (): PtyOutputBus => outputBus,

    removeRun(runId: string): void {
      const run = runs.get(runId);
      if (!run) return;
      run.terminal.dispose();
      outputBus.clear(runId);
      runs.delete(runId);
    },

    getFakeRun: (runId: string) => runs.get(runId),
  };
  return manager;
}
