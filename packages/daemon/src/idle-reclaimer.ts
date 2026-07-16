/**
 * 空闲回收器 (Idle Reclaimer)。
 *
 * 工作中的 agent 队列空 + 60 秒无活动 → 自动优雅关闭并保存 sessionId。
 * 下次消息到达时自动冷启动恢复。
 */

export interface IdleReclaimerOptions {
  timeoutMs?: number;       // 默认 60000ms
  scanIntervalMs?: number;  // 默认 30000ms
  onReclaim: (name: string, idleMs: number) => void;
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
        try {
          opts.onReclaim(name, idleMs);
        } catch (err: any) {
          console.error(`[IdleReclaimer] onReclaim(${name}) failed:`, err?.message);
        }
        untrack(name);
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
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
};