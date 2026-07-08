// ============================================================
// WebSocket 连接管理 — 双重连接 + ACK + 在线状态 + 离线缓存
// 向后兼容：保持所有导出接口不变
// ============================================================

import type { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { PresenceManager } from "./presence.js";
import { OfflineQueue } from "./offline-queue.js";
import type { AgentMessage } from "@collabagent/shared";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

// ======== 连接管理（保持现有导出接口） ========

const browserClients = new Map<string, Set<WebSocket>>();
export const daemonClients = new Map<string, WebSocket>();

export interface DaemonMeta {
  userId: string; hostname: string; daemonVersion: string; runtimes: string[]; connectedAt: number;
}
export const daemonMeta = new Map<string, DaemonMeta>();

// ======== Phase 1 新增：在线状态 + 离线队列 ========

export const presenceManager = new PresenceManager({
  onStatusChange: (agentId: string, oldStatus: string, newStatus: string) => {
    broadcastToDaemons({
      type: "status_change", agentId, oldStatus, newStatus,
      timestamp: new Date().toISOString(),
    });
  },
});

export const offlineQueue = new OfflineQueue({
  onDeliver: (agentId, message) => {
    const ws = daemonClients.get(agentId);
    if (ws?.readyState === 1) { try { ws.send(JSON.stringify(message)); } catch { /* ignore */ } }
  },
});

// ======== token 解析（不变） ========

function parseAuthToken(req: any): string | null {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match) return match[1];
  const cookieHeader: string = req.headers?.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "access_token") return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ======== WS 入口（签名不变） ========

export function wsHandler(connection: WebSocket, req: any) {
  const token = parseAuthToken(req);
  const isDaemon = !!token && token.startsWith("sk_machine_");
  const earlyBuffer: Buffer[] = [];
  const bufferEarly = (raw: Buffer) => { earlyBuffer.push(raw); };
  connection.on("message", bufferEarly);

  void resolveUserId(token, isDaemon).then((userId) => {
    connection.off("message", bufferEarly);
    if (isDaemon && userId === "anon") {
      console.warn("[WS] Daemon auth failed; closing with 4001");
      try { connection.close(4001, "unauthorized"); } catch { /* ignore */ }
      return;
    }
    registerConnection(connection, userId, isDaemon);
    for (const raw of earlyBuffer) connection.emit("message", raw);
    // 上线推送离线消息
    if (isDaemon) {
      const pending = offlineQueue.flush(userId);
      for (const msg of pending) { try { connection.send(JSON.stringify(msg)); } catch { /* ignore */ } }
    }
  });
}

async function resolveUserId(token: string | null, isDaemon: boolean): Promise<string> {
  if (!token) return "anon";
  if (isDaemon) {
    if (!wsPg) return "anon";
    try {
      const bcrypt = (await import("bcryptjs")).default;
      const result = await wsPg.query(
        "SELECT user_id, token_hash FROM machine_tokens WHERE token_prefix = 'sk_machine_' AND revoked_at IS NULL"
      );
      for (const row of result.rows as any[]) {
        if (await bcrypt.compare(token, row.token_hash)) return String(row.user_id);
      }
    } catch { /* fall through */ }
    return "anon";
  }
  try { return (jwt.verify(token, JWT_SECRET) as { sub: string }).sub; }
  catch { return "anon"; }
}

function registerConnection(connection: WebSocket, userId: string, isDaemon: boolean) {
  if (isDaemon) {
    daemonClients.set(userId, connection);
    daemonMeta.set(userId, { userId, hostname: "unknown", daemonVersion: "?", runtimes: [], connectedAt: Date.now() });
    presenceManager.register(userId, connection, { agentId: userId });
    console.log(`[WS] Daemon connected: user=${userId}`);

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "ready": {
            console.log(`[WS] Daemon ready: runtimes=${msg.runtimes}`);
            const meta = daemonMeta.get(userId);
            if (meta) {
              if (msg.hostname) meta.hostname = String(msg.hostname);
              if (msg.daemonVersion) meta.daemonVersion = String(msg.daemonVersion);
              if (Array.isArray(msg.runtimes)) meta.runtimes = msg.runtimes.map(String);
            }
            presenceManager.register(userId, connection, {
              agentId: userId, hostname: msg.hostname, daemonVersion: msg.daemonVersion, runtimes: msg.runtimes,
            });
            break;
          }
          case "agent:status": console.log(`[WS] Agent status: ${msg.status}`); break;
          case "agent:activity": console.log(`[WS] Agent activity: ${msg.activity}`); break;
          // Phase 1: 心跳
          case "heartbeat":
            presenceManager.heartbeat(userId);
            try { connection.send(JSON.stringify({ type: "heartbeat_ack", timestamp: new Date().toISOString() })); } catch { /* ignore */ }
            break;
          case "pong":
            presenceManager.heartbeat(userId);
            break;
          // Phase 1: ACK
          case "ack": {
            const ack = msg.content || {};
            if (ack.ack_message_id) offlineQueue.acknowledge(userId, ack.ack_message_id);
            break;
          }
          default: break;
        }
      } catch { /* ignore */ }
    });

    connection.on("close", () => {
      daemonClients.delete(userId);
      daemonMeta.delete(userId);
      presenceManager.unregister(userId);
      console.log(`[WS] Daemon disconnected: user=${userId}`);
    });

    connection.send(JSON.stringify({ type: "connected", serverTime: new Date().toISOString() }));
  } else {
    if (!browserClients.has(userId)) browserClients.set(userId, new Set());
    browserClients.get(userId)!.add(connection);
    connection.on("message", (raw) => { try { const msg = JSON.parse(raw.toString()); if (msg.type === "pong") return; } catch { /* ignore */ } });
    connection.on("close", () => { browserClients.get(userId)?.delete(connection); });
    connection.send(JSON.stringify({ type: "connected", time: new Date().toISOString() }));
  }
}

// ======== pg 引用 ========

let wsPg: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } | null = null;
export function setWsPg(pg: typeof wsPg) { wsPg = pg; }

// ======== 广播（保持现有签名） ========

export async function broadcast(channelId: string, event: any) {
  const payload = JSON.stringify(event);
  let allowedHumanIds: Set<string> | null = null;
  try {
    if (wsPg && channelId) {
      const ch = await wsPg.query("SELECT type FROM channels WHERE id = $1", [channelId]);
      const t = (ch.rows[0] as any)?.type;
      if (t === "private" || t === "dm") {
        const m = await wsPg.query(
          "SELECT member_id FROM channel_members WHERE channel_id = $1 AND member_type = 'human'", [channelId]
        );
        allowedHumanIds = new Set((m.rows as any[]).map((r) => String(r.member_id)));
      }
    }
  } catch { /* fall through */ }
  for (const [userId, sockets] of browserClients) {
    if (allowedHumanIds && !allowedHumanIds.has(userId)) continue;
    for (const ws of sockets) { try { ws.send(payload); } catch { /* ignore */ } }
  }
  for (const [, ws] of daemonClients) { try { ws.send(payload); } catch { /* ignore */ } }
}

export function sendToDaemon(userId: string, event: any) {
  const daemon = daemonClients.get(userId);
  if (daemon) { try { daemon.send(JSON.stringify(event)); } catch { /* ignore */ } }
}

export function broadcastToDaemons(event: any) {
  const payload = JSON.stringify(event);
  for (const [, ws] of daemonClients) { try { ws.send(payload); } catch { /* ignore */ } }
}

// ======== Phase 1 新增：带 ACK 的精准投递 ========

export function sendWithAck(userId: string, message: AgentMessage): boolean {
  const ws = daemonClients.get(userId);
  const isHigh = message.priority === "HIGH" || message.priority === "CRITICAL";
  if (ws?.readyState === 1) {
    try { ws.send(JSON.stringify(message)); if (isHigh) offlineQueue.enqueue(userId, message); return true; }
    catch { /* fall through */ }
  }
  offlineQueue.enqueue(userId, message);
  return false;
}
