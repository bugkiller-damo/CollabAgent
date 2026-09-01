import type {
  RuntimeProbe,
  WsChannelBroadcast,
  WsFromBrowserMessage,
  WsFromDaemonMessage,
  WsToBrowserMessage,
  WsToDaemonMessage,
} from "@collabagent/shared";
import type { WebSocket } from "ws";
import { appendEvent } from "../lib/audit.js";
// P1.15：令牌校验逻辑统一在 lib/auth-token.ts——机器令牌（sk_machine_）与浏览器
// JWT 的校验 HTTP/WS 共用同一实现（此前逐行重复两份，修 bug 必改两处；浏览器
// JWT 此前 jsonwebtoken 直验，与 @fastify/jwt 双库并存靠注释约定同步 secret）。
import { verifyBrowserToken, verifyMachineToken } from "../lib/auth-token.js";
import type { PubSub } from "../lib/pubsub.js";
import { normalizeRuntimes } from "../lib/runtime-probe.js";

// Anonymous browser clients (keyed by userId)
export const browserClients = new Map<string, Set<WebSocket>>();
// Daemon connections (keyed by userId — one per user machine)
export const daemonClients = new Map<string, WebSocket>();
// Daemon 元数据（握手 ready 上报）：用于运维仪表盘展示逐个 daemon 明细
export interface DaemonMeta {
  userId: string;
  hostname: string;
  daemonVersion: string;
  runtimes: RuntimeProbe[];
  connectedAt: number;
  os?: string;
  arch?: string;
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

  // P1.14：客户端 IP 传给 resolveUserId，供 bcrypt 兼容路径护栏按 IP 限速——
  // 与 HTTP 侧 request.ip 同源（@fastify/websocket 传 FastifyRequest 有 .ip；
  // 兜底 raw req 的 socket.remoteAddress）。
  const clientIp = String(req?.ip || req?.socket?.remoteAddress || "");

  void resolveUserId(token, isDaemon, clientIp, req)
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

async function resolveUserId(token: string | null, isDaemon: boolean, clientIp = "", req?: any): Promise<string> {
  if (!token) return "anon";
  if (isDaemon) {
    if (!wsPg) return "anon";
    try {
      // P1.15：sk_machine_ 校验（sha256 快路径 + bcrypt 兼容路径 + P1.14 护栏 +
      // O8 退役指引）收敛到 lib/auth-token.ts，HTTP/WS 共用同一实现。
      // renewal="always"：P1.12 daemon 连接即把有效期顺延到 +90 天——连接频率低，
      // 不做 HTTP 侧的阈值门控；与 HTTP 阈值续期共同构成「活跃令牌不过期」。
      // guard-rejected / invalid 都按 "anon" 返回（上游以 4001 关闭）：
      // 护栏超限不触达 DB 与 bcrypt，过期/未知/用户缺失不通过。
      const v = await verifyMachineToken(wsPg, token, {
        clientIp,
        renewal: "always",
        log: { warn: (obj, msg) => console.warn("[WS] " + msg, obj) },
      });
      return v.ok ? v.userId : "anon";
    } catch {
      /* fall through to anon */
    }
    return "anon";
  }
  try {
    // 浏览器分支：与 HTTP 同源的浏览器 JWT 校验（@fastify/jwt access namespace +
    // P1.15 session 回查 + 强制 sid）——此前 jsonwebtoken 直验且不回查，
    // logout-all 后 WS 长连接仍有效。
    const u = await verifyBrowserToken(req?.server?.jwt?.access, wsPg, token);
    return u ? u.userId : "anon";
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
        const msg = JSON.parse(raw.toString()) as WsFromDaemonMessage;
        switch (msg.type) {
          case "ready": {
            const runtimes = normalizeRuntimes(msg.runtimes);
            console.log(`[WS] Daemon ready: runtimes=${runtimes.map((r) => r.id).join(",")}`);
            const meta = daemonMeta.get(userId);
            if (meta) {
              if (msg.hostname) meta.hostname = String(msg.hostname);
              if (msg.daemonVersion) meta.daemonVersion = String(msg.daemonVersion);
              meta.runtimes = runtimes;
              if (typeof msg.os === "string") meta.os = msg.os;
              if (typeof msg.arch === "string") meta.arch = msg.arch;
            }
            persistComputerReady(userId, {
              hostname: msg.hostname,
              os: typeof msg.os === "string" ? msg.os : undefined,
              arch: typeof msg.arch === "string" ? msg.arch : undefined,
              daemonVersion: msg.daemonVersion,
              runtimes,
            });
            void import("../lib/agent-duty.js").then(({ broadcastOwnerPresence }) =>
              broadcastOwnerPresence(wsPg, userId),
            );
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
          case "agent:delivery-dead-letter":
            // A1 派发队列死信：daemon 重试耗尽/入队即判不可投递 → 浏览器 error toast，
            // 消息确认未送达，需要人工介入（重发或检查 agent）
            console.warn(
              `[WS] delivery dead-letter: agent=${msg.agentName} channel=${msg.channelName} err=${msg.error}`,
            );
            sendToUser(userId, msg);
            break;
          case "agent:progress":
            // T4：频道顶栏「正在做什么」——只转给该用户浏览器（与 agent:status 同通道）
            sendToUser(userId, msg);
            break;
          case "agent:tool-call": {
            // C1：agent 本地工具调用生命周期进审计链（O2 的 agent 侧补充）。
            // object 建模为 agent（而非 tool_call）——审计 API 的访问控制按对象
            // 判定（routes/audit.ts assertObjectAccess），agent 对象的可见性 =
            // 「agent 属于该用户」，正好匹配 daemon→user 的归属关系。
            // 频率是每个工具调用 2 条（pending/completed），哈希链 advisory lock
            // 串行化在这个量级无压力。审计失败不阻断转发链（best-effort）。
            const m = msg as Record<string, unknown>;
            if (wsPg?.transaction && m.agentId) {
              wsPg
                .transaction((tx) =>
                  appendEvent(tx, {
                    actorId: String(m.agentId),
                    actorType: "agent",
                    verb: m.status === "pending" ? "tool.call.start" : "tool.call.end",
                    objectType: "agent",
                    objectId: String(m.agentId),
                    payload: {
                      agentName: m.agentName,
                      toolName: m.toolName,
                      toolUseId: m.toolUseId,
                      status: m.status,
                      text: m.text,
                      time: m.time,
                    },
                  }),
                )
                .catch((err) => console.warn("[WS] tool-call audit append failed:", (err as Error)?.message ?? err));
            }
            break;
          }
          case "terminal:frame": {
            // daemon 推来的终端帧 → 只发给这个 agent 的观众（不是所有浏览器连接）。
            // O1：经 pub/sub 发布，观众无论在哪个实例都能收到（本地观众由发布者直投覆盖）。
            const agentName = (msg as Record<string, unknown>).agentName as string | undefined;
            if (agentName) publish({ kind: "terminal-frame", userId, agentName, event: msg });
            break;
          }
          case "terminal:obs-frame": {
            // B1 结构化观察帧：与 terminal:frame 同一条观众定向通道（按 agentName 引用计数）
            const agentName = (msg as Record<string, unknown>).agentName as string | undefined;
            if (agentName) publish({ kind: "terminal-frame", userId, agentName, event: msg });
            break;
          }
          case "terminal:obs-history":
            // B1 观察帧 replay buffer（打开事件流面板时补历史）——同 terminal:history 的低频路径
            sendToUser(userId, msg);
            break;
          case "terminal:history": {
            // daemon 回传的历史日志 → 发给该用户所有浏览器连接（请求方面板消费，
            // 负载小且频次低，不值得再维护请求级路由）
            sendToUser(userId, msg);
            break;
          }
          case "workspace:result":
            resolveWorkspaceResult(msg);
            break;
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
      void import("../lib/agent-duty.js").then(({ broadcastOwnerPresence }) => broadcastOwnerPresence(wsPg, userId));
    });

    attachHeartbeat(connection);
    connection.send(JSON.stringify({ type: "connected", serverTime: new Date().toISOString() }));
  } else {
    // Browser client
    if (!browserClients.has(userId)) browserClients.set(userId, new Set());
    browserClients.get(userId)!.add(connection);

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsFromBrowserMessage;
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
let wsPg: {
  query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  /** C1 工具调用审计用（appendEvent 必须在事务内）；可选以保持测试注入的最小形状 */
  transaction?: <T = unknown>(
    fn: (tx: {
      query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[] }>;
    }) => Promise<T>,
  ) => Promise<T>;
} | null = null;
export function setWsPg(pg: typeof wsPg) {
  wsPg = pg;
}

/** 首次 ready：没有 computers 行就按 hostname 插一条；已有则刷新探测字段 */
function persistComputerReady(
  userId: string,
  probe: { hostname?: string; os?: string; arch?: string; daemonVersion?: string; runtimes?: RuntimeProbe[] },
): void {
  if (!wsPg) return;
  const hostname = probe.hostname ? String(probe.hostname) : null;
  const os = probe.os ? String(probe.os) : null;
  const arch = probe.arch ? String(probe.arch) : null;
  const daemonVersion = probe.daemonVersion ? String(probe.daemonVersion) : null;
  const name = (hostname && hostname !== "unknown" ? hostname : "我的计算机").slice(0, 80);
  void (async () => {
    try {
      const existing = await wsPg!.query<{ id: string }>("SELECT id FROM computers WHERE user_id::text = $1", [userId]);
      if (existing.rows.length > 0) {
        await wsPg!.query(
          `UPDATE computers SET
             hostname = COALESCE($2, hostname),
             os = COALESCE($3, os),
             arch = COALESCE($4, arch),
             daemon_version = COALESCE($5, daemon_version),
             runtimes = $6::jsonb,
             last_ready_at = now()
           WHERE user_id::text = $1`,
          [userId, hostname, os, arch, daemonVersion, JSON.stringify(probe.runtimes ?? [])],
        );
        return;
      }
      const orgs = await wsPg!.query<{ server_id: string }>(
        "SELECT server_id FROM server_members WHERE user_id::text = $1 LIMIT 1",
        [userId],
      );
      let serverId = orgs.rows[0]?.server_id;
      if (!serverId) {
        const created = await wsPg!.query<{ id: string }>(
          "INSERT INTO servers (name, created_by, owner_id, personal) VALUES ($1, $2, $3, true) RETURNING id",
          ["我的私有空间", userId, userId],
        );
        serverId = created.rows[0]!.id;
        await wsPg!.query(
          "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
          [serverId, userId],
        );
      }
      await wsPg!.query(
        `INSERT INTO computers (user_id, server_id, name, description, hostname, os, arch, daemon_version, runtimes, last_ready_at)
         VALUES ($1, $2, $3, '', $4, $5, $6, $7, $8::jsonb, now())
         ON CONFLICT (user_id) DO UPDATE SET
           hostname = COALESCE(EXCLUDED.hostname, computers.hostname),
           os = COALESCE(EXCLUDED.os, computers.os),
           arch = COALESCE(EXCLUDED.arch, computers.arch),
           daemon_version = COALESCE(EXCLUDED.daemon_version, computers.daemon_version),
           runtimes = EXCLUDED.runtimes,
           last_ready_at = now()`,
        [userId, serverId, name, hostname, os, arch, daemonVersion, JSON.stringify(probe.runtimes ?? [])],
      );
    } catch (err) {
      console.warn("[WS] persist computer ready failed:", (err as Error)?.message ?? err);
    }
  })();
}

/**
 * 按频道定向广播：
 * - 公开频道：投递给所有浏览器连接 + 所有 daemon。
 * - 私有频道：浏览器端只投递给该频道的人类成员；daemon 端仍全发（agent 是否响应由其按成员/@提及自行判断）。
 * channelId 传频道 UUID。
 *
 * P0.2 fail-closed：频道类型/成员解析失败（DB 抖动、频道不存在、类型未知）时放弃广播，
 * 不再退回全发——否则 DB 抖动窗口内私有频道/DM 的明文事件会广播给全部浏览器（内容泄露）。
 * 代价是抖动窗口内丢事件，但消息可经 REST 按 seq 游标补拉恢复，安全优先于送达。
 *
 * O1：改为跨实例 pub/sub —— 本实例解析完成员后，把「信封」发布到 Valkey channel，
 * 每个实例（含本实例）订阅后按各自的本地 socket 表投递。多实例部署时实例间不再互相看不见。
 */
export async function broadcast(channelId: string, event: WsChannelBroadcast) {
  let allowedHumanIds: string[] | null = null; // null = 不限制（公开）
  let resolved = false;
  try {
    if (wsPg && channelId) {
      const ch = await wsPg.query<{ type: string }>("SELECT type FROM channels WHERE id = $1", [channelId]);
      const t = ch.rows[0]?.type;
      if (t === "private" || t === "dm") {
        // 私有频道与 DM 都按成员定向：仅其人类成员的浏览器收到
        const m = await wsPg.query<{ member_id: string }>(
          "SELECT member_id FROM channel_members WHERE channel_id = $1 AND member_type = 'human'",
          [channelId],
        );
        allowedHumanIds = m.rows.map((r) => String(r.member_id));
        resolved = true;
      } else if (t === "public") {
        resolved = true;
      }
      // t 为 undefined（频道不存在）或未知类型值（type 列暂无 CHECK 约束，见 P1.32）
      // → resolved 保持 false，走下方 fail-closed
    }
  } catch {
    /* 解析失败：fail-closed，见下 */
  }

  if (!resolved) {
    console.warn(`[WS] broadcast: channel resolve failed (id=${channelId}), dropping event (fail-closed)`);
    return;
  }

  publish({ kind: "channel", channelId, allowedHumanIds, event });
}

/** Send a message to a specific daemon */
export function sendToDaemon(userId: string, event: WsToDaemonMessage) {
  publish({ kind: "daemon", userId, event });
}

type WorkspaceResult = Extract<WsFromDaemonMessage, { type: "workspace:result" }>;
const workspaceWaiters = new Map<string, (msg: WorkspaceResult) => void>();

function resolveWorkspaceResult(msg: WsFromDaemonMessage): void {
  if (msg.type !== "workspace:result") return;
  const waiter = workspaceWaiters.get(msg.requestId);
  if (!waiter) return;
  workspaceWaiters.delete(msg.requestId);
  waiter(msg);
}

/** 向本机 daemon 要工作区文件；daemon 离线或超时返回 null */
export function requestDaemonWorkspace(
  userId: string,
  agentName: string,
  path?: string,
  timeoutMs = 4000,
): Promise<WorkspaceResult | null> {
  if (!daemonClients.has(userId)) return Promise.resolve(null);
  const requestId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      workspaceWaiters.delete(requestId);
      resolve(null);
    }, timeoutMs);
    workspaceWaiters.set(requestId, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    sendToDaemon(
      userId,
      path ? { type: "workspace:read", requestId, agentName, path } : { type: "workspace:read", requestId, agentName },
    );
  });
}

/** Broadcast to all connected daemons */
export function broadcastToDaemons(event: any) {
  publish({ kind: "all-daemons", event });
}

/** Send a message to a specific user's browser clients */
export function sendToUser(userId: string, event: WsToBrowserMessage) {
  publish({ kind: "user", userId, event });
}

// ---------- 跨实例 pub/sub（O1） ----------
const PUBSUB_CHANNEL = "slock:ws:v1";

type WsEnvelope =
  | { kind: "channel"; channelId: string; allowedHumanIds: string[] | null; event: any }
  | { kind: "user"; userId: string; event: any }
  | { kind: "daemon"; userId: string; event: any }
  | { kind: "all-daemons"; event: any }
  | { kind: "terminal-frame"; userId: string; agentName: string; event: any };

let pubsub: PubSub | null = null;

/** 由 index.ts 启动时注入 pubsub 实例并订阅广播 channel。 */
export function setPubSub(p: PubSub): void {
  pubsub = p;
  p.subscribe(PUBSUB_CHANNEL, (payload) => handleEnvelope(payload as WsEnvelope));
}

function publish(env: WsEnvelope): void {
  // pubsub 尚未注入（模块极早期）→ 本地直投兜底，避免消息凭空消失
  if (pubsub) pubsub.publish(PUBSUB_CHANNEL, env);
  else handleEnvelope(env);
}

function deliver(sockets: Iterable<WebSocket>, payload: string): void {
  for (const ws of sockets) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

/** 收到信封后按 kind 投递给本实例的本地 socket 表（发布者与订阅者共用同一逻辑）。 */
function handleEnvelope(env: WsEnvelope): void {
  switch (env?.kind) {
    case "channel": {
      const allowed = env.allowedHumanIds ? new Set(env.allowedHumanIds) : null;
      const payload = JSON.stringify(env.event);
      for (const [userId, sockets] of browserClients) {
        if (allowed && !allowed.has(userId)) continue; // 私有频道：非成员浏览器不投递
        deliver(sockets, payload);
      }
      for (const [, ws] of daemonClients) {
        try {
          ws.send(payload);
        } catch {
          /* ignore */
        }
      }
      break;
    }
    case "user": {
      const sockets = browserClients.get(env.userId);
      if (sockets) deliver(sockets, JSON.stringify(env.event));
      break;
    }
    case "daemon": {
      const daemon = daemonClients.get(env.userId);
      if (daemon) {
        try {
          daemon.send(JSON.stringify(env.event));
        } catch {
          /* ignore */
        }
      }
      break;
    }
    case "all-daemons": {
      const payload = JSON.stringify(env.event);
      for (const [, ws] of daemonClients) {
        try {
          ws.send(payload);
        } catch {
          /* ignore */
        }
      }
      break;
    }
    case "terminal-frame": {
      const set = terminalWatchers.get(env.userId)?.get(env.agentName);
      if (set) deliver(set, JSON.stringify(env.event));
      break;
    }
    default:
      break; // 未知 kind / 脏数据 → 丢弃
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
    for (const ws of sockets) {
      heartbeatPing(ws);
      // P1.21：JSON 应用层 ping——web 看门狗（70s 无 onmessage 即重连）感知不了协议层
      // ping/pong，靠应用层 ping 喂狗；连接建立时也即发一条（registerConnection）。
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* ignore */
      }
    }
  }
}, HEARTBEAT_INTERVAL);

// 在 registerConnection 中 hook pong 响应
// 在 connection.on("message") 外层添加 on("pong")
// 通过 monkey-patch registerConnection 太复杂，简单方案：修改 open 事件注册
// 下面 export 可供外部在 connection 上绑定 pong
export function attachHeartbeat(ws: WebSocket) {
  ws.on("pong", () => heartbeatPong(ws));
}
