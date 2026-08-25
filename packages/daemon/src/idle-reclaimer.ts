import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { PersistentClaude } from "./drivers/persistent-claude.js";
import type { IAgentManager } from "./types/index.js";

/**
 * 空闲回收器 (Idle Reclaimer)。
 *
 * 工作中的 agent 队列空 + 超时无活动 → 自动优雅关闭。下次消息到达时冷启动。
 * 模块默认 timeout 60s / 扫描 30s；runtime 覆盖为 1800s（SLOCK_IDLE_RECLAIM_MS）。
 * onReclaim 返回 false 时跳过 untrack（P0.2：仍 working/starting 时不误杀）。
 */

export interface IdleReclaimerOptions {
  timeoutMs?: number; // 默认 60000ms；runtime 覆盖为 1800s（SLOCK_IDLE_RECLAIM_MS）
  scanIntervalMs?: number; // 默认 30000ms
  /**
   * 返回 `false` 表示本次跳过（例如 agent 仍 working/starting），
   * 保留跟踪，下次扫描再试。其它返回值（含 void）按已回收处理并 untrack。
   */
  onReclaim: (name: string, idleMs: number) => void | boolean;
}

export interface IIdleReclaimer {
  touch(name: string): void;
  untrack(name: string): void;
  getIdleMs(name: string): number;
  start(): void;
  stop(): void;
}

export const createIdleReclaimer = (opts: IdleReclaimerOptions): IIdleReclaimer => {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const scanIntervalMs = opts.scanIntervalMs ?? 30000;
  const lastActivityAt = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const touch = (name: string): void => {
    lastActivityAt.set(name, Date.now());
  };

  const untrack = (name: string): void => {
    lastActivityAt.delete(name);
  };

  const getIdleMs = (name: string): number => {
    const last = lastActivityAt.get(name);
    if (last === undefined) return 0;
    return Date.now() - last;
  };

  const scan = (): void => {
    const now = Date.now();
    for (const [name, last] of lastActivityAt.entries()) {
      const idleMs = now - last;
      if (idleMs >= timeoutMs) {
        console.log(`[IdleReclaimer] @${name} idle for ${Math.round(idleMs / 1000)}s, reclaiming`);
        let keep = false;
        try {
          keep = opts.onReclaim(name, idleMs) === false;
        } catch (err: any) {
          console.error(`[IdleReclaimer] onReclaim(${name}) failed:`, err?.message);
        }
        if (!keep) untrack(name);
      }
    }
  };

  return {
    touch,
    untrack,
    getIdleMs,
    start(): void {
      if (timer) return;
      timer = setInterval(scan, scanIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
};

/**
 * 空闲回收动作（P0.2）。PTY 走 `stopRun` → 退出清理链；headless 必须额外
 * `PersistentClaude.stop()` 并踢掉 `persistentSessions`，否则子进程永不退出。
 *
 * working/starting 时返回 false——dispatch 漏 untrack 时也不能杀进行中的回合，
 * reclaimer 会保留跟踪、下次扫描再试。
 */
export const reclaimIdleAgent = (opts: {
  name: string;
  runIdByAgent: Map<string, string>;
  agentManager: Pick<IAgentManager, "stopRun">;
  persistentSessions: Map<string, PersistentClaude>;
  stateMachine: Pick<IAgentStateMachine, "getState" | "transitionState">;
  /** P0.5：常驻进程被回收后清会话累计基线 */
  onSessionEnded?: (name: string) => void;
}): boolean | void => {
  const { name, runIdByAgent, agentManager, persistentSessions, stateMachine, onSessionEnded } = opts;
  const status = stateMachine.getState(name);
  if (status === "working" || status === "starting") {
    console.log(`[IdleReclaimer] @${name} still ${status}, skip reclaim`);
    return false;
  }

  const runId = runIdByAgent.get(name);
  if (runId) {
    // PTY：真正的 Map/token/状态清理交给退出清理链 onExit
    agentManager.stopRun(runId);
  }

  const session = persistentSessions.get(name);
  if (session) {
    session.stop();
    persistentSessions.delete(name);
    if (status && status !== "stopped" && status !== "idle") {
      try {
        stateMachine.transitionState(name, "idle");
      } catch {
        /* 无效迁移已在内部吞掉 */
      }
    }
    console.log(`[IdleReclaimer] @${name} headless session reclaimed`);
  }
  if (session || runId) onSessionEnded?.(name);
};
