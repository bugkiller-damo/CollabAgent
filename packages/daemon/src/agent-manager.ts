import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentRunSnapshot, IAgentManager, PtyOutputBus, PtyOutputEvent, StartAgentInput } from "./types/index.js";

/**
 * Agent 进程管理器。
 *
 * 封装子进程的 spawn/kill/通信逻辑，当前使用 child_process.spawn，
 * 设计上兼容未来替换为 node-pty。
 *
 * ### 职责
 * - 启动 Agent 进程（spawn）
 * - 停止、暂停、恢复进程
 * - 向 stdin 写入数据
 * - 调整终端尺寸
 * - 通过 PtyOutputBus 暴露 stdout/stderr 输出
 */
export const createAgentManager = (): IAgentManager => {
  const processes = new Map<string, { proc: ChildProcess; snapshot: AgentRunSnapshot }>();
  const emitter = new EventEmitter();

  const outputBus: PtyOutputBus = {
    on(event: "data", handler: (ev: PtyOutputEvent) => void): void {
      emitter.on(event, handler);
    },
    off(event: "data", handler: (ev: PtyOutputEvent) => void): void {
      emitter.off(event, handler);
    },
  };

  return {
    async startAgent(input: StartAgentInput): Promise<AgentRunSnapshot> {
      const runId = randomUUID();
      const cols = input.cols ?? 80;
      const rows = input.rows ?? 24;

      const proc = spawn(input.agentName, [], {
        cwd: input.workspaceDir,
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...input.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const snapshot: AgentRunSnapshot = {
        runId,
        agentId: input.agentId,
        pid: proc.pid ?? 0,
        status: "running",
        exitCode: null,
        cols,
        rows,
        startedAt: Date.now(),
      };

      processes.set(runId, { proc, snapshot });

      proc.stdout?.on("data", (data: Buffer) => {
        const ev: PtyOutputEvent = { runId, data: data.toString(), timestamp: Date.now() };
        emitter.emit("data", ev);
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const ev: PtyOutputEvent = { runId, data: data.toString(), timestamp: Date.now() };
        emitter.emit("data", ev);
      });

      proc.on("exit", (code) => {
        snapshot.exitCode = code;
        snapshot.status = "exited";
      });

      proc.on("error", () => {
        snapshot.status = "error";
      });

      return snapshot;
    },

    stopRun(runId: string): void {
      const entry = processes.get(runId);
      if (!entry) return;
      try { entry.proc.kill(); } catch { /* ignore */ }
      entry.snapshot.status = "exited";
    },

    writeInput(runId: string, input: string | Buffer): void {
      const entry = processes.get(runId);
      if (!entry?.proc.stdin) return;
      entry.proc.stdin.write(input);
    },

    resizeRun(runId: string, _cols: number, _rows: number): void {
      // node-pty: pty.resize(cols, rows)
      // child_process.spawn: no-op (not supported without PTY)
      const entry = processes.get(runId);
      if (entry) {
        entry.snapshot.cols = _cols;
        entry.snapshot.rows = _rows;
      }
    },

    pauseRun(runId: string): void {
      const entry = processes.get(runId);
      if (!entry) return;
      try { entry.proc.kill("SIGSTOP"); } catch { /* Windows: no SIGSTOP */ }
    },

    resumeRun(runId: string): void {
      const entry = processes.get(runId);
      if (!entry) return;
      try { entry.proc.kill("SIGCONT"); } catch { /* Windows: no SIGCONT */ }
    },

    getRun(runId: string): AgentRunSnapshot | undefined {
      return processes.get(runId)?.snapshot;
    },

    getOutputBus(): PtyOutputBus {
      return outputBus;
    },
  };
};
