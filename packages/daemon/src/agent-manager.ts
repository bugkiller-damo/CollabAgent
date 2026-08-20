/**
 * ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）
 * 本文件仅服务 PTY fallback（SLOCK_USE_PTY=1）。headless 是默认且受支持的路径。
 * 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。
 * 保留原因：headless 尚未经过长期验证（2026-08-18 起默认）。
 * 删除评估：headless 稳定运行满 6 周后（2026-09 底）按
 * docs/2026-08-20/02-daemon-evolution-tracker.md Step 3 原删除方案执行。
 */
import { randomUUID } from "node:crypto";
import { type IPty, spawn } from "node-pty";
import { applyAgentEnv } from "./agent-env-whitelist.js";
import { type AgentRunProcess, attachAgentPty, finishAgentRun, toAgentRunSnapshot } from "./agent-manager-support.js";
import { createPtyOutputBus } from "./pty-output-bus.js";
import { createTerminalState } from "./terminal-state.js";
import type { AgentRunSnapshot, IAgentManager, PtyOutputBus, StartAgentInput } from "./types/index.js";

/**
 * Agent 进程管理器。
 *
 * 使用 node-pty 创建伪终端（PTY）启动 Agent，支持：
 * - 完整终端环境（提示符、ANSI 转义、颜色）
 * - 真正的 resize / pause / resume 信号
 * - 按 runId 索引的输出总线
 *
 * 接口与 child_process 实现保持一致（IAgentManager），上层调用方无感切换。
 *
 * ### 职责
 * - 启动 Agent 进程（pty.spawn）
 * - 停止、暂停、恢复进程
 * - 向 PTY 写入数据
 * - 调整终端尺寸
 * - 通过 PtyOutputBus 暴露 stdout/stderr 输出
 */
export const createAgentManager = (): IAgentManager => {
  const processes = new Map<string, AgentRunProcess>();
  const outputBus: PtyOutputBus = createPtyOutputBus();

  return {
    async startAgent(input: StartAgentInput): Promise<AgentRunSnapshot> {
      const runId = randomUUID();
      const cols = input.cols ?? 80;
      const rows = input.rows ?? 24;

      // node-pty 直连子进程，不经 cmd.exe 间接启动
      // A2：env 白名单化（默认 warn-only，SLOCK_ENV_WHITELIST=1 收紧）；
      // input.env 已是 buildPtyEnv 的产物（SLOCK_* + TERM 系列），白名单模式下
      // 作为 overrides 显式追加，O11 语义不变（明文 token 在 applyAgentEnv 里剔除）
      const pty: IPty = spawn(input.agentName, input.args ?? [], {
        cwd: input.workspaceDir,
        env: applyAgentEnv((input.env ?? {}) as Record<string, string>, `PTY:${input.agentName}`),
        cols,
        rows,
        name: "xterm-256color",
      });

      const run: AgentRunProcess = {
        runId,
        agentId: input.agentId,
        pid: (pty.pid as number) ?? 0,
        pty,
        output: "",
        terminal: createTerminalState(cols, rows),
        status: "running",
        exitCode: null,
        cols,
        rows,
        startedAt: Date.now(),
        // 绑定 runId（此刻已知，调用方的 onExit 只关心自己那次 start 的结果）
        onExit: input.onExit ? (exitCode) => input.onExit!(runId, exitCode) : undefined,
        stop: () => {},
        write: () => {},
        resize: () => {},
        pause: () => {},
        resume: () => {},
        isStopped: () => false,
      };

      attachAgentPty(run, pty, outputBus);
      processes.set(runId, run);

      return toAgentRunSnapshot(run);
    },

    stopRun(runId: string): void {
      const entry = processes.get(runId);
      if (!entry) return;
      entry.stop();
    },

    writeInput(runId: string, input: string | Buffer): void {
      const entry = processes.get(runId);
      if (!entry) return;
      entry.write(input);
    },

    resizeRun(runId: string, cols: number, rows: number): void {
      const entry = processes.get(runId);
      if (!entry) return;
      entry.resize(cols, rows);
    },

    pauseRun(runId: string): void {
      const entry = processes.get(runId);
      if (!entry) return;
      entry.pause();
    },

    resumeRun(runId: string): void {
      const entry = processes.get(runId);
      if (!entry) return;
      entry.resume();
    },

    getRun(runId: string): AgentRunSnapshot | undefined {
      const entry = processes.get(runId);
      if (!entry) return undefined;
      return toAgentRunSnapshot(entry);
    },

    getOutputBus(): PtyOutputBus {
      return outputBus;
    },

    removeRun(runId: string): void {
      removeAgentRun(processes, outputBus, runId);
    },
  };
};

/**
 * 内部使用：从注册表移除 run 并清理订阅者（agent-runtime 负责调用）。
 * 不放在 IAgentManager 接口里以保持接口最小化。
 */
export const removeAgentRun = (
  processes: Map<string, AgentRunProcess>,
  outputBus: PtyOutputBus,
  runId: string,
): void => {
  const entry = processes.get(runId);
  if (!entry) return;
  outputBus.clear(runId);
  try {
    entry.terminal.dispose();
  } catch {
    /* 已经 dispose 过或本来就没启动完整 */
  }
  processes.delete(runId);
};

export type { AgentRunProcess };
/** 暴露辅助函数供上层 runtime 直接调用 */
export { attachAgentPty, finishAgentRun, toAgentRunSnapshot };
