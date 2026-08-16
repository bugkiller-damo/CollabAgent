import type { ILiveRunRegistry, LiveAgentRun } from "./types/index.js";

/**
 * 退出协调器 (Exit Coordinator)。
 *
 * 解决启动竞态：进程在 spawn 之后、registry.add() 之前崩溃时，
 * 必须保留退出码并在 add() 之后立即处理。
 *
 * 流程：createExitEntry -> spawn -> [exit?] -> add (检查 pending) -> resolveExit
 */

export interface IExitCoordinator {
  preSpawn(runId: string): void;
  register(run: LiveAgentRun): void;
  onExit(runId: string, exitCode: number | null): void;
  onSpawnError(runId: string, error: Error): void;
}

export const createExitCoordinator = (
  registry: ILiveRunRegistry,
  onExit?: (runId: string, exitCode: number | null) => void,
): IExitCoordinator => {
  return {
    preSpawn(runId: string): void {
      registry.createExitEntry(runId);
    },

    register(run: LiveAgentRun): void {
      registry.add(run);
    },

    onExit(runId: string, exitCode: number | null): void {
      const existing = registry.get(runId);
      if (existing) {
        existing.exitCode = exitCode;
        existing.status = exitCode === 0 ? "exited" : "error";
        registry.resolveExit(runId);
      } else {
        registry.setPendingExitCode(runId, exitCode);
      }
      if (onExit) {
        try {
          onExit(runId, exitCode);
        } catch {
          /* ignore */
        }
      }
    },

    onSpawnError(runId: string, _error: Error): void {
      registry.setPendingExitCode(runId, -1);
      if (onExit) {
        try {
          onExit(runId, -1);
        } catch {
          /* ignore */
        }
      }
    },
  };
};
