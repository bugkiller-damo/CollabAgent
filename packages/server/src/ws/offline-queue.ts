// ============================================================
// 离线消息缓存队列
// 智能体离线期间消息缓存，上线后自动推送未读
// 支持 ACK 超时重试 + 消息过期清理
// ============================================================

import type { AgentMessage, ISO8601, MessagePriority } from "@collabagent/shared";

const DEFAULT_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS: Record<MessagePriority, number[]> = {
  LOW: [5000],
  MEDIUM: [5000, 15000],
  HIGH: [3000, 6000, 12000],
  CRITICAL: [1000, 3000, 9000],
};

interface QueuedMessage {
  message: AgentMessage;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: number;
  createdAt: number;
  expireAt: number;
  lastAttempt?: number;
  acked: boolean;
}

type MessageHandler = (agentId: string, message: AgentMessage) => void;

export class OfflineQueue {
  private queue = new Map<string, QueuedMessage[]>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private onDeliver?: MessageHandler;

  constructor(opts?: { onDeliver?: MessageHandler }) {
    this.onDeliver = opts?.onDeliver;
    this.startRetryLoop();
  }

  enqueue(agentId: string, message: AgentMessage): void {
    const priority = message.priority || "MEDIUM";
    const delays = RETRY_DELAYS[priority] || RETRY_DELAYS.MEDIUM;
    const entry: QueuedMessage = {
      message,
      retryCount: 0,
      maxRetries: delays.length,
      nextRetryAt: Date.now() + (delays[0] || 5000),
      createdAt: Date.now(),
      expireAt: Date.now() + DEFAULT_EXPIRE_MS,
      acked: false,
    };
    let list = this.queue.get(agentId);
    if (!list) { list = []; this.queue.set(agentId, list); }
    list.push(entry);
  }

  acknowledge(agentId: string, messageId: string): boolean {
    const list = this.queue.get(agentId);
    if (!list) return false;
    const idx = list.findIndex((m) => m.message.messageId === messageId && !m.acked);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.queue.delete(agentId);
    return true;
  }

  getPending(agentId: string): AgentMessage[] {
    const list = this.queue.get(agentId);
    if (!list) return [];
    const now = Date.now();
    return list
      .filter((m) => !m.acked && m.nextRetryAt <= now && m.retryCount < m.maxRetries)
      .map((m) => m.message);
  }

  flush(agentId: string): AgentMessage[] {
    const list = this.queue.get(agentId);
    if (!list) return [];
    return list.filter((m) => !m.acked).map((m) => m.message);
  }

  pendingCount(agentId: string): number {
    return this.queue.get(agentId)?.filter((m) => !m.acked).length ?? 0;
  }

  totalPending(): number {
    let total = 0;
    for (const [, list] of this.queue) total += list.filter((m) => !m.acked).length;
    return total;
  }

  destroy(): void {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    this.queue.clear();
  }

  private startRetryLoop(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => this.processRetries(), 1000);
    this.retryTimer.unref();
  }

  private processRetries(): void {
    const now = Date.now();
    for (const [agentId, list] of this.queue) {
      for (const entry of list) {
        if (entry.acked) continue;
        if (now > entry.expireAt) { entry.acked = true; continue; }
        if (entry.retryCount < entry.maxRetries && now >= entry.nextRetryAt) {
          const priority = entry.message.priority || "MEDIUM";
          const delays = RETRY_DELAYS[priority] || RETRY_DELAYS.MEDIUM;
          entry.retryCount++;
          entry.lastAttempt = now;
          entry.nextRetryAt = now + (delays[Math.min(entry.retryCount, delays.length - 1)] || 5000);
          this.onDeliver?.(agentId, entry.message);
        }
        if (entry.retryCount >= entry.maxRetries) entry.acked = true;
      }
      const active = list.filter((m) => !m.acked);
      if (active.length === 0) this.queue.delete(agentId);
      else this.queue.set(agentId, active);
    }
  }
}
