// ============================================================
// 智能体在线状态管理
// 三元状态：online / offline / busy
// 心跳超时检测 + 状态变更广播
// ============================================================

import type { WebSocket } from "ws";
import type { AgentOnlineStatus, AgentPresence, ISO8601 } from "@collabagent/shared";

const HEARTBEAT_TIMEOUT_MS = 30_000;
const CLEANUP_INTERVAL_MS = 15_000;

interface PresenceEntry {
  presence: AgentPresence;
  ws: WebSocket;
  lastHeartbeat: number;
  status: AgentOnlineStatus;
}

export class PresenceManager {
  private agents = new Map<string, PresenceEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private onStatusChange?: (agentId: string, oldStatus: AgentOnlineStatus, newStatus: AgentOnlineStatus) => void;

  constructor(opts?: { onStatusChange?: typeof PresenceManager.prototype.onStatusChange }) {
    this.onStatusChange = opts?.onStatusChange;
  }

  register(agentId: string, ws: WebSocket, meta?: Partial<AgentPresence>): void {
    const now = Date.now();
    const prev = this.agents.get(agentId);
    const oldStatus = prev?.status ?? "offline";
    const entry: PresenceEntry = {
      presence: {
        agentId,
        status: "online",
        hostname: meta?.hostname,
        daemonVersion: meta?.daemonVersion,
        runtimes: meta?.runtimes,
        connectedAt: new Date(now).toISOString() as ISO8601,
        lastHeartbeat: new Date(now).toISOString() as ISO8601,
      },
      ws,
      lastHeartbeat: now,
      status: "online",
    };
    this.agents.set(agentId, entry);
    this.onStatusChange?.(agentId, oldStatus, "online");
    this.startCleanup();
  }

  unregister(agentId: string): void {
    const prev = this.agents.get(agentId);
    if (!prev) return;
    const oldStatus = prev.status;
    this.agents.delete(agentId);
    this.onStatusChange?.(agentId, oldStatus, "offline");
    if (this.agents.size === 0) this.stopCleanup();
  }

  heartbeat(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    const oldStatus = entry.status;
    entry.lastHeartbeat = Date.now();
    entry.presence.lastHeartbeat = new Date().toISOString() as ISO8601;
    if (entry.status !== "online") {
      entry.status = "online";
      entry.presence.status = "online";
      this.onStatusChange?.(agentId, oldStatus, "online");
    }
  }

  setBusy(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status === "busy") return;
    const oldStatus = entry.status;
    entry.status = "busy";
    entry.presence.status = "busy";
    this.onStatusChange?.(agentId, oldStatus, "busy");
  }

  getStatus(agentId: string): AgentOnlineStatus {
    return this.agents.get(agentId)?.status ?? "offline";
  }

  getPresence(agentId: string): AgentPresence | null {
    return this.agents.get(agentId)?.presence ?? null;
  }

  getAllOnline(): string[] {
    const result: string[] = [];
    for (const [id, entry] of this.agents) {
      if (entry.status !== "offline") result.push(id);
    }
    return result;
  }

  getAllPresence(): AgentPresence[] {
    return Array.from(this.agents.values()).map((e) => e.presence);
  }

  isOnline(agentId: string): boolean {
    return this.agents.has(agentId) && this.agents.get(agentId)!.status !== "offline";
  }

  destroy(): void {
    this.stopCleanup();
    this.agents.clear();
  }

  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.checkHeartbeats(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  private stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [id, entry] of this.agents) {
      if (now - entry.lastHeartbeat > HEARTBEAT_TIMEOUT_MS && entry.status !== "offline") {
        const oldStatus = entry.status;
        entry.status = "offline";
        entry.presence.status = "offline";
        this.onStatusChange?.(id, oldStatus, "offline");
      }
    }
  }
}
