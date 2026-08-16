import jwt from "jsonwebtoken";
import type { WebSocket } from "ws";
import { config } from "../lib/config.js";

// 必须与 fastify-jwt 注册时的默认一致，否则浏览器 token 验不过 → 都变 "anon"
const JWT_SECRET = config.JWT_SECRET;

// Anonymous browser clients (keyed by userId)
export const browserClients = new Map<string, Set<WebSocket>>();
// Daemon connections (keyed by userId — one per user machine)
export const daemonClients = new Map<string, WebSocket>();
// Daemon 元数据（握手 ready 上报）：用于运维仪表盘展示逐个 daemon 明细
export interface DaemonMeta {
  userId: string;
  hostname: string;
  daemonVersion: string;
  runtimes: string[];
  connectedAt: number;
}
export const daemonMeta = new Map<string, DaemonMeta>();

// 终端观察（G3）：userId -> agentName -> 观众 socket 集合。
// 引用计数：第一个观众出现才通知 daemon 开始推帧，最后一个断开才停止——
// 无人观看时这条链路零开销。
const terminalWatchers = new Map<string, Map<string, Set<WebSocket>>>();

function addTerminalWatcher(userId: string, agentName: string, ws: WebSocket): void {
  let byAgent = terminalWatchers.get(userId);
  if (!byAgent) {
    byAgent = new Map();
    terminalWatchers.set(userId, byAgent);
  }
  let set = byAgent.get(agentName);
  if (!set) {
    set = new Set();
    byAgent.set(agentName, set);
  }
  const wasEmpty = set.size === 0;
  set.add(ws);
  if (wasEmpty) sendToDaemon(userId, { type: "terminal:watch", agentName });
}

function removeTerminalWatcher(userId: string, agentName: string, ws: WebSocket): void {
  const set = terminalWatchers.get(userId)?.get(agentName);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    terminalWatchers.get(userId)?.delete(agentName);
    sendToDaemon(userId, { type: "terminal:unwatch", agentName });
  }
}

/** socket 断开时，把它从该用户所有观看集合里清掉 */
function removeTerminalWatcherSocket(userId: string, ws: WebSocket): void {
  const byAgent = terminalWatchers.get(userId);
  if (!byAgent) return;
  for (const [agentName, set] of [...byAgent.entries()]) {
    set.delete(ws);
    if (set.size === 0) {
      byAgent.delete(agentName);
      sendToDaemon(userId, { type: "terminal:unwatch", agentName });
    }
  }
}

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
  // daemon 用机器令牌（sk_machine_）握手，需 bcrypt 比对解析出真实 userId；
  // 浏览器用 JWT。两者都要按 userId 登记，daemon 才能与 agent 的 user_id 对上（驱动 isOnline）。
  const isDaemon = !!token && token.startsWith("sk_machine_");

  // resolveUserId 是异步的（daemon 要 bcrypt 比对令牌），但客户端在 open 后立刻发 ready。
  // 先缓冲早到的消息，注册完成后回放，避免 ready 元数据丢失。
  const earlyBuffer: Buffer[] = [];
  const bufferEarly = (raw: Buffer) => {
    earlyBuffer.push(raw);
  };
  connection.on("message", bufferEarly);

  void resolveUserId(token, isDaemon)
    .then((userId) => {
      connection.off("message", bufferEarly);
      // daemon 令牌无效/被吊销 → resolveUserId 返回 "anon"。明确用 4001 关闭，
      // 而不是把它当匿名 daemon 登记，否则 daemon 会误以为已连上并无限重连。
      if (isDaemon && userId === "anon") {
        console.warn("[WS] Daemon auth failed (invalid/revoked machine token); closing with 4001");
        try {
          connection.close(4001, "unauthorized");
        } catch {
          /* ignore */
        }
        return;
      }
      // 浏览器 token 无效同样拒绝：此前降级为 "anon" 登记，导致未登录连接也能
      // 收到所有公开频道的消息广播（内容泄露）。统一按未授权关闭。
      if (!isDaemon && userId === "anon") {
        try {
          connection.close(4001, "unauthorized");
        } catch {
          /* ignore */
        }
        return;
      }
      registerConnection(connection, userId, isDaemon);
      for (const raw of earlyBuffer) connection.emit("message", raw);
    })
    .catch(() => {
      try {
        connection.close(1011, "internal error");
      } catch {
        /* ignore */
      }
    });
}

async function resolveUserId(token: string | null, isDaemon: boolean): Promise<string> {
  if (!token) return "anon";
  if (isDaemon) {
    if (!wsPg) return "anon";
    try {
      const { sha256Token, isBcryptHash } = await import("../lib/token-hash.js");
      // 快路径：sha256 直接索引命中（新令牌）
      const fast = await wsPg.query<{ user_id: string }>(
        "SELECT user_id FROM machine_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
        [sha256Token(token)],
      );
      if (fast.rows.length > 0) return String(fast.rows[0].user_id);
      // 兼容路径：历史 bcrypt 令牌逐行比对（轮换后可删除）
      const bcrypt = (await import("bcryptjs")).default;
      const result = await wsPg.query<{ user_id: string; token_hash: string }>(
        "SELECT user_id, token_hash FROM machine_tokens WHERE revoked_at IS NULL",
      );
      for (const row of result.rows) {
        if (isBcryptHash(row.token_hash) && (await bcrypt.compare(token, row.token_hash))) return String(row.user_id);
      }
    } catch {
      /* fall through to anon */
    }
    return "anon";
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; handle?: string };
    return decoded.sub;
  } catch {
    return "anon"; // Invalid token — treat as anonymous browser client
  }
}

function registerConnection(connection: WebSocket, userId: string, isDaemon: boolean) {
  if (isDaemon) {
    daemonClients.set(userId, connection);
    daemonMeta.set(userId, { userId, hostname: "unknown", daemonVersion: "?", runtimes: [], connectedAt: Date.now() });
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
            break;
          }
          case "agent:status":
            // 转发给该用户的浏览器（Agent 状态栏实时显示，G7 last_pty_line）
            sendToUser(userId, msg);
            break;
          case "agent:delivery-queued":
            // 门控投递反馈：daemon 把忙碌期消息排队了 → 浏览器 toast"已缓冲，空闲后投递"
            sendToUser(userId, msg);
            break;
          case "agent:activity":
            console.log(`[WS] Agent activity: ${msg.activity}`);
            break;
          case "terminal:frame": {
            // daemon 推来的终端帧 → 只发给这个 agent 的观众（不是所有浏览器连接）
            const agentName = (msg as Record<string, unknown>).agentName as string | undefined;
            const set = agentName ? terminalWatchers.get(userId)?.get(agentName) : undefined;
            if (set) {
              const payload = JSON.stringify(msg);
              for (const ws of set) {
                try {
                  ws.send(payload);
                } catch {
                  /* ignore */
                }
              }
            }
            break;
          }
          case "terminal:history": {
            // daemon 回传的历史日志 → 发给该用户所有浏览器连接（请求方面板消费，
            // 负载小且频次低，不值得再维护请求级路由）
            sendToUser(userId, msg);
            break;
          }
          case "pong":
            break;
        }
      } catch {
        /* ignore */
      }
    });

    connection.on("close", () => {
      daemonClients.delete(userId);
      daemonMeta.delete(userId);
      console.log(`[WS] Daemon disconnected: user=${userId}`);
    });

    attachHeartbeat(connection);
    connection.send(JSON.stringify({ type: "connected", serverTime: new Date().toISOString() }));
  } else {
    // Browser client
    if (!browserClients.has(userId)) browserClients.set(userId, new Set());
    browserClients.get(userId)!.add(connection);

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") return;
        // 终端观察（G3）：浏览器请求观看/停止观看某个 agent 的终端
        if (msg.type === "terminal:watch" && typeof msg.agentName === "string") {
          addTerminalWatcher(userId, msg.agentName, connection);
        } else if (msg.type === "terminal:unwatch" && typeof msg.agentName === "string") {
          removeTerminalWatcher(userId, msg.agentName, connection);
        } else if (msg.type === "terminal:history" && typeof msg.agentName === "string") {
          // 历史日志请求：一次性转发给 daemon（响应经下方 daemon 分支 sendToUser 回来）
          sendToDaemon(userId, { type: "terminal:history", agentName: msg.agentName });
        } else if (msg.type === "terminal:resize" && typeof msg.agentName === "string") {
          // 面板尺寸协商：浏览器把期望的 cols/rows 转发给 daemon（实时 resize PTY）
          sendToDaemon(userId, { type: "terminal:resize", agentName: msg.agentName, cols: msg.cols, rows: msg.rows });
        }
      } catch {
        /* ignore */
      }
    });

    connection.on("close", () => {
      browserClients.get(userId)?.delete(connection);
      removeTerminalWatcherSocket(userId, connection);
    });

    attachHeartbeat(connection);
    connection.send(JSON.stringify({ type: "connected", time: new Date().toISOString() }));
  }
}

// pg 引用，用于按频道成员定向投递（在 index.ts 启动时注入）
let wsPg: { query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> } | null = null;
export function setWsPg(pg: typeof wsPg) {
  wsPg = pg;
}

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
      const ch = await wsPg.query<{ type: string }>("SELECT type FROM channels WHERE id = $1", [channelId]);
      const t = ch.rows[0]?.type;
      // 私有频道与 DM 都按成员定向：仅其人类成员的浏览器收到
      if (t === "private" || t === "dm") {
        const m = await wsPg.query<{ member_id: string }>(
          "SELECT member_id FROM channel_members WHERE channel_id = $1 AND member_type = 'human'",
          [channelId],
        );
        allowedHumanIds = new Set(m.rows.map((r) => String(r.member_id)));
      }
    }
  } catch {
    /* 解析失败：allowedHumanIds 保持 null，退回全发 */
  }

  for (const [userId, sockets] of browserClients) {
    if (allowedHumanIds && !allowedHumanIds.has(userId)) continue; // 私有频道：非成员浏览器不投递
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
  for (const [, ws] of daemonClients) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

/** Send a message to a specific daemon */
export function sendToDaemon(userId: string, event: any) {
  const daemon = daemonClients.get(userId);
  if (daemon) {
    try {
      daemon.send(JSON.stringify(event));
    } catch {
      /* ignore */
    }
  }
}

/** Broadcast to all connected daemons */
export function broadcastToDaemons(event: any) {
  const payload = JSON.stringify(event);
  for (const [, ws] of daemonClients) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

/** Send a message to a specific user's browser clients */
export function sendToUser(userId: string, event: any) {
  const sockets = browserClients.get(userId);
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

/** Export daemon clients map for external access */

// ---- 心跳检测（周期性 ping，清理死连接）----
const HEARTBEAT_INTERVAL = 30_000; // 30s
const HEARTBEAT_TIMEOUT = 10_000; // 10s 无 pong 视为断开

interface ConnMeta {
  alive: boolean;
  pingTimer?: NodeJS.Timeout;
}

const connMeta = new WeakMap<WebSocket, ConnMeta>();

function heartbeatPing(ws: WebSocket) {
  const meta = connMeta.get(ws) || { alive: true };
  if (!meta.alive) {
    // 上次 ping 没回 pong → 断开
    try {
      ws.close(1001, "heartbeat timeout");
    } catch {
      /* ignore */
    }
    return;
  }
  meta.alive = false;
  meta.pingTimer = setTimeout(() => heartbeatPing(ws), HEARTBEAT_TIMEOUT);
  connMeta.set(ws, meta);
  try {
    ws.ping();
  } catch {
    /* ignore */
  }
}

function heartbeatPong(ws: WebSocket) {
  const meta = connMeta.get(ws);
  if (meta) {
    meta.alive = true;
    if (meta.pingTimer) clearTimeout(meta.pingTimer);
  }
}

// 全局心跳脉冲
setInterval(() => {
  for (const [, ws] of daemonClients) heartbeatPing(ws);
  for (const [, sockets] of browserClients) {
    for (const ws of sockets) heartbeatPing(ws);
  }
}, HEARTBEAT_INTERVAL);

// 在 registerConnection 中 hook pong 响应
// 在 connection.on("message") 外层添加 on("pong")
// 通过 monkey-patch registerConnection 太复杂，简单方案：修改 open 事件注册
// 下面 export 可供外部在 connection 上绑定 pong
export function attachHeartbeat(ws: WebSocket) {
  ws.on("pong", () => heartbeatPong(ws));
}
