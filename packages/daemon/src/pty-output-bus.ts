import type { PtyOutputEvent } from "./types/index.js";

type OutputListener = (ev: PtyOutputEvent) => void;

/**
 * PTY 输出事件总线。
 *
 * 按 runId 索引的发布/订阅通道，agent-manager 通过 `publish` 广播 PTY 输出，
 * agent-runtime 通过 `subscribe` 监听特定 run 的输出。
 *
 * 设计要点：
 * - 监听器按 runId 索引，避免全量广播
 * - subscribe 返回 unsubscribe 函数，便于调用方安全清理
 * - clear 彻底释放单个 run 的所有监听器
 */
export interface PtyOutputBus {
  publish(ev: PtyOutputEvent): void;
  subscribe(runId: string, listener: OutputListener): () => void;
  clear(runId: string): void;
  listenerCount(runId: string): number;
}

export const createPtyOutputBus = (): PtyOutputBus => {
  const listenersByRunId = new Map<string, Set<OutputListener>>();

  return {
    publish(ev) {
      const listeners = listenersByRunId.get(ev.runId);
      if (!listeners || listeners.size === 0) return;
      for (const listener of listeners) {
        try { listener(ev); } catch (err: any) {
          // 单个监听器抛错不应影响其他订阅者
          console.error("[PtyOutputBus] listener error:", err?.message ?? err);
        }
      }
    },

    subscribe(runId, listener) {
      let listeners = listenersByRunId.get(runId);
      if (!listeners) {
        listeners = new Set();
        listenersByRunId.set(runId, listeners);
      }
      listeners.add(listener);
      return () => {
        const set = listenersByRunId.get(runId);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) listenersByRunId.delete(runId);
      };
    },

    clear(runId) {
      listenersByRunId.delete(runId);
    },

    listenerCount(runId) {
      return listenersByRunId.get(runId)?.size ?? 0;
    },
  };
};
