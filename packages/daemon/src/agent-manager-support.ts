/**
 * ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）
 * 本文件仅服务 PTY fallback（SLOCK_USE_PTY=1）。headless 是默认且受支持的路径。
 * 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。
 * 保留原因：headless 尚未经过长期验证（2026-08-18 起默认）。
 * 删除评估：headless 稳定运行满 6 周后（2026-09 底）按
 * docs/2026-08-20/02-daemon-evolution-tracker.md Step 3 原删除方案执行。
 */
import type { IPty } from "node-pty";
import type { PtyOutputBus } from "./pty-output-bus.js";
import { createTerminalState, type ITerminalState } from "./terminal-state.js";
import type { AgentRunSnapshot, RunStatus } from "./types/index.js";

/** 单次 Agent 运行的进程封装（含 PTY 句柄与控制方法） */
export interface AgentRunProcess {
  runId: string;
  agentId: string;
  pid: number;
  pty: IPty;
  output: string;
  status: RunStatus;
  exitCode: number | null;
  cols: number;
  rows: number;
  startedAt: number;
  /** 终端状态跟踪器（见 terminal-state.ts）——由 createAgentManager 在 spawn 时
   *  创建，外部一律通过 AgentRunSnapshot.screenText 读取，不直接操作它 */
  terminal: ITerminalState;
  /** 退出时触发的回调（由 attachAgentPty 注册） */
  onExit?: (exitCode: number | null) => void;
  stop: (signal?: string) => void;
  write: (input: string | Buffer) => void;
  resize: (cols: number, rows: number) => void;
  pause: () => void;
  resume: () => void;
  isStopped: () => boolean;
}

/** 防止 output 无限累积导致 OOM */
export const MAX_RUN_OUTPUT_LENGTH = 1_000_000;

/**
 * 绑定 PTY 事件到 run + outputBus。
 *
 * 行为：
 * - `pty.onData` → 追加到 `run.output`（按 MAX_RUN_OUTPUT_LENGTH 截断）→ 通过 bus 广播
 * - `pty.onExit` → 标记 exited → 调用 `run.onExit` 回调
 * - 组装 process 控制方法（stop/write/resize/pause/resume/isStopped）
 *
 * 返回值即 `run` 本身（已附加方法），方便链式调用。
 */
export const attachAgentPty = (run: AgentRunProcess, pty: IPty, outputBus: PtyOutputBus): AgentRunProcess => {
  // ---- 控制方法 ----
  run.stop = (signal?: string) => {
    if (run.isStopped()) return;
    try {
      pty.kill(signal);
    } catch {
      /* 已退出 */
    }
  };

  run.write = (input: string | Buffer) => {
    if (run.isStopped()) return;
    try {
      pty.write(input);
    } catch (err: any) {
      console.error(`[AgentMgr] write failed for ${run.runId}:`, err?.message ?? err);
    }
  };

  run.resize = (cols: number, rows: number) => {
    run.cols = cols;
    run.rows = rows;
    try {
      pty.resize(cols, rows);
    } catch {
      /* resize 在已退出时可能失败 */
    }
    try {
      run.terminal.resize(cols, rows);
    } catch {
      /* 不应该失败，防御性 */
    }
  };

  run.pause = () => {
    try {
      pty.pause();
    } catch {
      /* Windows 上可能不支持 */
    }
  };

  run.resume = () => {
    try {
      pty.resume();
    } catch {
      /* Windows 上可能不支持 */
    }
  };

  run.isStopped = () => run.status === "exited" || run.status === "error";

  // ---- 事件绑定 ----
  pty.onData((data: string) => {
    run.output += data;
    if (run.output.length > MAX_RUN_OUTPUT_LENGTH) {
      run.output = run.output.slice(-MAX_RUN_OUTPUT_LENGTH);
    }
    // 必须等 write 真正应用到屏幕缓冲区之后（回调触发）才广播——xterm 对大段
    // 输入是异步分块处理的，提前广播的话订阅者（回合结束检测等）读到的
    // screenText 可能还是上一段数据的旧状态。
    run.terminal.write(data, () => {
      outputBus.publish({ runId: run.runId, data, timestamp: Date.now() });
    });
  });

  pty.onExit(({ exitCode }: { exitCode: number }) => {
    finishAgentRun(run, exitCode);
  });

  return run;
};

/**
 * 标记 run 结束状态。
 *
 * - exitCode 为 0 → "exited"
 * - exitCode 非 0 或 null → "error"
 * - 若已注册 onExit 回调，触发之
 * - 幂等：重复调用仅更新 exitCode
 */
export const finishAgentRun = (run: AgentRunProcess, exitCode: number | null): void => {
  if (run.status === "exited" || run.status === "error") {
    if (run.exitCode === null) run.exitCode = exitCode;
    return;
  }
  run.exitCode = exitCode;
  run.status = exitCode === 0 ? "exited" : "error";
  if (run.onExit) {
    try {
      run.onExit(exitCode);
    } catch (err: any) {
      console.error(`[AgentMgr] onExit callback failed for ${run.runId}:`, err?.message ?? err);
    }
  }
};

/** 提取 run 快照（用于暴露给 agent-runtime / live-run-registry） */
export const toAgentRunSnapshot = (run: AgentRunProcess): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: run.agentId,
  pid: run.pid,
  status: run.status,
  exitCode: run.exitCode,
  output: run.output,
  screenText: run.terminal.getScreenText(),
  // 最近 ~400 行历史（scrollback + 当前屏）——终端观察的回看与退出落盘用
  historyText: run.terminal.getHistoryText(400),
  cols: run.cols,
  rows: run.rows,
  startedAt: run.startedAt,
});
