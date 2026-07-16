import type { ILiveRunRegistry, LiveAgentRun } from "./types/index.js";

/**
 * 创建活跃运行注册表。
 *
 * 追踪当前所有正在运行的 Agent 进程实例，并提供退出时序保护：
 *
 * ### 竞态：进程在 add() 前退出
 *
 * spawn() → createExitEntry() → add() → ... → handleExit()
 *              │                  │
 *        进程在 add() 前退出 ────→ setPendingExitCode(code)
 *                                  │
 *                            add() 后检查 pending → 立即处理退出
 *
 * ### 竞态：旧 exit_cb vs 新 spawn（由 agent-tokens 处理）
 * revokeIfMatches 负责 token 隔离，本注册表仅做运行记录管理。
 */
export const createLiveRunRegistry = (): ILiveRunRegistry => {
  const runs = new Map<string, LiveAgentRun>();
  const pendingExitCodes = new Map<string, number | null>();
  const exitEntries = new Set<string>();

  return {
    // ---- 基础 CRUD ----

    add(run: LiveAgentRun): void {
      runs.set(run.runId, run);
      // 检查是否有进程在 add() 前就已退出的 pending 记录
      if (pendingExitCodes.has(run.runId)) {
        run.exitCode = pendingExitCodes.get(run.runId)!;
        run.status = "exited";
        pendingExitCodes.delete(run.runId);
      }
    },

    get(runId: string): LiveAgentRun | undefined {
      return runs.get(runId);
    },

    remove(runId: string): void {
      runs.delete(runId);
      pendingExitCodes.delete(runId);
      exitEntries.delete(runId);
    },

    list(): LiveAgentRun[] {
      return Array.from(runs.values());
    },

    // ---- 退出通道（时序保护）----

    /** 在 spawn 后立即调用，先建立退出通道，防止进程在 add() 前退出 */
    createExitEntry(runId: string): void {
      exitEntries.add(runId);
    },

    /** 标记退出完成并清理通道 */
    resolveExit(runId: string): void {
      exitEntries.delete(runId);
      // 保留 run 记录 30 秒供查询，之后可被清理
      const run = runs.get(runId);
      if (run) {
        run.status = "exited";
      }
    },

    // ---- Pending exit code（进程在 add() 前退出的兜底）----

    setPendingExitCode(runId: string, exitCode: number | null): void {
      pendingExitCodes.set(runId, exitCode);
      // 如果 run 已注册，直接应用
      const run = runs.get(runId);
      if (run) {
        run.exitCode = exitCode;
        run.status = "exited";
        pendingExitCodes.delete(runId);
      }
    },

    hasPendingExitCode(runId: string): boolean {
      return pendingExitCodes.has(runId);
    },

    clearPendingExitCode(runId: string): void {
      pendingExitCodes.delete(runId);
    },
  };
};
