import type { WebSocket } from "ws";
import jwt from "jsonwebtoken";

// 必须与 fastify-jwt 注册时的默认一致，否则浏览器 token 验不过 → 都变 "anon"
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

// Anonymous browser clients (keyed by userId)
const browserClients = new Map<string, Set<WebSocket>>();
// Daemon connections (keyed by userId — one per user machine)
export const daemonClients = new Map<string, WebSocket>();

function parseAuthToken(req: any): string | null {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match) return match[1];
  // 浏览器 WS 握手带不了 Authorization 头，但会自动带 cookie —— 从 httpOnly cookie 取 access_token
  const cookieHeader: string = req.headers?.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "access_token") {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

export function wsHandler(connection: WebSocket, req: any) {
  const token = parseAuthToken(req);
  let userId = "anon";

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; handle?: string };
      userId = decoded.sub;
    } catch {
      // Invalid token — treat as anonymous browser client
    }
  }

  // Check if this is a daemon connection (has api key auth)
  const isDaemon = token && token.startsWith("sk_machine_");

  if (isDaemon) {
    daemonClients.set(userId, connection);
    console.log(`[WS] Daemon connected: user=${userId}`);

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "ready":
            console.log(`[WS] Daemon ready: runtimes=${msg.runtimes}`);
            break;
          case "agent:status":
            console.log(`[WS] Agent status: ${msg.status}`);
            break;
          case "agent:activity":
            console.log(`[WS] Agent activity: ${msg.activity}`);
            break;
          case "pong":
            break;
        }
      } catch { /* ignore */ }
    });

    connection.on("close", () => {
      daemonClients.delete(userId);
      console.log(`[WS] Daemon disconnected: user=${userId}`);
    });

    connection.send(JSON.stringify({ type: "connected", serverTime: new Date().toISOString() }));
  } else {
    // Browser client
    if (!browserClients.has(userId)) browserClients.set(userId, new Set());
    browserClients.get(userId)!.add(connection);

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") return;
      } catch { /* ignore */ }
    });

    connection.on("close", () => {
      browserClients.get(userId)?.delete(connection);
    });

    connection.send(JSON.stringify({ type: "connected", time: new Date().toISOString() }));
  }
}

// pg 引用，用于按频道成员定向投递（在 index.ts 启动时注入）
let wsPg: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } | null = null;
export function setWsPg(pg: typeof wsPg) { wsPg = pg; }

/**
 * 按频道定向广播：
 * - 公开频道：投递给所有浏览器连接 + 所有 daemon。
 * - 私有频道：浏览器端只投递给该频道的人类成员；daemon 端仍全发（agent 是否响应由其按成员/@提及自行判断）。
 * channelId 传频道 UUID。解析失败则退回全发（避免漏发）。
 */
export async function broadcast(channelId: string, event: any) {
  const payload = JSON.stringify(event);
  let allowedHumanIds: Set<string> | null = null; // null = 不限制（公开）
  try {
    if (wsPg && channelId) {
      const ch = await wsPg.query("SELECT type FROM channels WHERE id = $1", [channelId]);
      const t = (ch.rows[0] as any)?.type;
      // 私有频道与 DM 都按成员定向：仅其人类成员的浏览器收到
      if (t === "private" || t === "dm") {
        const m = await wsPg.query(
          "SELECT member_id FROM channel_members WHERE channel_id = $1 AND member_type = 'human'",
          [channelId]
        );
        allowedHumanIds = new Set((m.rows as any[]).map((r) => String(r.member_id)));
      }
    }
  } catch { /* 解析失败：allowedHumanIds 保持 null，退回全发 */ }

  for (const [userId, sockets] of browserClients) {
    if (allowedHumanIds && !allowedHumanIds.has(userId)) continue; // 私有频道：非成员浏览器不投递
    for (const ws of sockets) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
  for (const [, ws] of daemonClients) {
    try { ws.send(payload); } catch { /* ignore */ }
  }
}

/** Send a message to a specific daemon */
export function sendToDaemon(userId: string, event: any) {
  const daemon = daemonClients.get(userId);
  if (daemon) {
    try { daemon.send(JSON.stringify(event)); } catch { /* ignore */ }
  }
}

/** Broadcast to all connected daemons */
export function broadcastToDaemons(event: any) {
  const payload = JSON.stringify(event);
  for (const [, ws] of daemonClients) {
    try { ws.send(payload); } catch { /* ignore */ }
  }
}

/** Export daemon clients map for external access */
