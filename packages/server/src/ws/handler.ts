import type {
  RuntimeProbe,
  WsChannelBroadcast,
  WsFromDaemonMessage,
  WsToBrowserMessage,
  WsToDaemonMessage,
} from "@collabagent/shared";
import type { WebSocket } from "ws";
// 2026-09-17 审计：公开频道扇出用 server 成员集合（带 TTL 缓存 + 主动失效）
import { getServerMemberIdSet } from "../lib/access.js";
import { appendEvent } from "../lib/audit.js";
// P1.15：令牌校验逻辑统一在 lib/auth-token.ts——机器令牌（sk_machine_）与浏览器
// JWT 的校验 HTTP/WS 共用同一实现（此前逐行重复两份，修 bug 必改两处；浏览器
// JWT 此前 jsonwebtoken 直验，与 @fastify/jwt 双库并存靠注释约定同步 secret）。
import { verifyBrowserToken, verifyMachineToken } from "../lib/auth-token.js";
import { inc } from "../lib/metrics.js";
// P1.27：daemon 连接/断开镜像进跨实例在线注册表（Redis SET，其他实例的读路径可见）
import { isComputerOnline, isMachineOnline, isUserScopeOnline, presenceAdd, presenceRemove } from "../lib/presence.js";
import type { PubSub } from "../lib/pubsub.js";
import { normalizeRuntimes } from "../lib/runtime-probe.js";
// P1.28：入站帧运行时校验（此前 JSON.parse as X 零校验）——畸形/未知 type 帧整帧丢弃
import { parseWsInbound, wsFromBrowserSchema, wsFromDaemonSchema } from "./validate.js";

// Anonymous browser clients (keyed by userId)
export const browserClients = new Map<string, Set<WebSocket>>();
// Daemon connections — keyed by machineKey = `${userId}:${machineUuid}`（每台机器一槽：
// 同一用户的多台机器各自持连接、可同 server 同时在场；同一台机器换 scope 重连时
// 同 machineKey 顶掉旧连接，兑现「一机同时只在一个 server」）。
// ready 帧携 machineUuid 到达前挂 provisional 键 `${userId}:~pending:<n>`；
// 缺省 machineUuid 的旧 daemon 按 `legacy-<userId>` 合成（等价旧版一人一机单槽）。
export const daemonClients = new Map<string, WebSocket>();
// Daemon 元数据（握手 ready 上报 + token scope）：用于运维仪表盘展示逐个 daemon 明细
export interface DaemonMeta {
  userId: string;
  /** 连接的权威 server scope（machine_tokens.server_id）——每条连接一个 scope */
  serverId: string | null;
  /** ready 上报的本机稳定身份（.slock/machine-id）；null = 尚未 ready */
  machineUuid: string | null;
  /** 当前 presence 成员串（register=`u|~pending|s`，ready 后=`u|machineUuid|s`）；断开按它移除 */
  presenceMember?: string;
  hostname: string;
  daemonVersion: string;
  runtimes: RuntimeProbe[];
  connectedAt: number;
  os?: string;
  arch?: string;
}
export const daemonMeta = new Map<string, DaemonMeta>();
// socket → 当前注册键（provisional 键在 ready 时会换成 machineKey，断开时靠它找回）
const daemonKeyOf = new Map<WebSocket, string>();
let pendingConnSeq = 0;

/** target 为 machineKey 时精确命中；为 userId 时取该用户任一连接（旧调用方兼容） */
function resolveDaemonConn(target: string): WebSocket | undefined {
  const direct = daemonClients.get(target);
  if (direct) return direct;
  const prefix = `${target}:`;
  for (const [key, ws] of daemonClients) {
    if (key === target || key.startsWith(prefix)) return ws;
  }
  return undefined;
}

/** 同 resolveDaemonConn 的 meta 版（routes 侧探测/展示用） */
export function findDaemonMeta(target: string): DaemonMeta | undefined {
  const direct = daemonMeta.get(target);
  if (direct) return direct;
  const prefix = `${target}:`;
  for (const [key, meta] of daemonMeta) {
    if (key === target || key.startsWith(prefix)) return meta;
  }
  return undefined;
}

/** 本实例持有 daemon 连接的 userId 去重集合（认领门控/订阅补齐用）。
 *  从连接键推导而非 daemonMeta——测试可只注 daemonClients 不注 meta。 */
export function localDaemonUserIds(): string[] {
  const out = new Set<string>();
  for (const key of daemonClients.keys()) out.add(key.split(":")[0]!);
  return [...out];
}

function userHasLocalDaemon(userId: string): boolean {
  const prefix = `${userId}:`;
  for (const key of daemonClients.keys()) {
    if (key === userId || key.startsWith(prefix)) return true;
  }
  return false;
}

// 终端观察（G3）：daemonTarget -> agentName -> 观众 socket 集合。
// daemonTarget = resolveTerminalWatchTarget 的返回值（绑定机 machineKey 或 owner userId）。
// 观众可以是「频道同事」（非 owner，见 resolveTerminalWatchTarget 的鉴权口径）——
// socket 一律挂在被观察 agent 的投递目标键下，daemon 帧按该目标发布天然到达。
// 引用计数：第一个观众出现才通知 daemon 开始推帧，最后一个断开才停止——
// 无人观看时这条链路零开销。
const terminalWatchers = new Map<string, Map<string, Set<WebSocket>>>();
// 反向索引：观众 socket -> 它挂着的 (owner, agentName) 集合——非 owner 观众的 socket
// 不在「自己的 userId」键下，断连/unwatch 时靠它 O(1) 找回，不用全表扫描。
const socketWatches = new Map<WebSocket, Array<{ owner: string; agentName: string }>>();
// (owner|agentName) → agent 的 server scope——watch/unwatch 转发给 daemon 时的 scope 守护参数；
// 断开路径是同步的，没法回库重解析，注册 watcher 时顺手记下。
const terminalScopes = new Map<string, string | null>();
const watchScopeKey = (owner: string, agentName: string) => `${owner}${agentName}`;

function addTerminalWatcher(owner: string, agentName: string, ws: WebSocket, scope: string | null): void {
  let byAgent = terminalWatchers.get(owner);
  if (!byAgent) {
    byAgent = new Map();
    terminalWatchers.set(owner, byAgent);
  }
  let set = byAgent.get(agentName);
  if (!set) {
    set = new Set();
    byAgent.set(agentName, set);
  }
  set.add(ws);
  terminalScopes.set(watchScopeKey(owner, agentName), scope);
  socketWatches.set(ws, [...(socketWatches.get(ws) ?? []), { owner, agentName }]);
  // 每个观众上线都转发一次 watch：daemon 对重复 watch 只补发回放（obs-history/history），
  // 不重启推帧节拍（daemon handlers/terminal.ts）——后到的观众也能看到打开面板前的内容。
  sendToDaemon(owner, { type: "terminal:watch", agentName }, { scope });
}

function removeWatcherFrom(owner: string, agentName: string, ws: WebSocket): void {
  const set = terminalWatchers.get(owner)?.get(agentName);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    terminalWatchers.get(owner)?.delete(agentName);
    const scopeKey = watchScopeKey(owner, agentName);
    const scope = terminalScopes.get(scopeKey) ?? null;
    terminalScopes.delete(scopeKey);
    sendToDaemon(owner, { type: "terminal:unwatch", agentName }, { scope });
  }
}

function removeTerminalWatcher(owner: string, agentName: string, ws: WebSocket): void {
  removeWatcherFrom(owner, agentName, ws);
  const list = socketWatches.get(ws);
  if (!list) return;
  const next = list.filter((w) => !(w.owner === owner && w.agentName === agentName));
  if (next.length > 0) socketWatches.set(ws, next);
  else socketWatches.delete(ws);
}

/** socket 断开时，把它从所有观看集合里清掉（含挂在他人 owner 键下的频道同事观众） */
function removeTerminalWatcherSocket(ws: WebSocket): void {
  const list = socketWatches.get(ws);
  if (!list) return;
  socketWatches.delete(ws);
  for (const { owner, agentName } of list) removeWatcherFrom(owner, agentName, ws);
}

/**
 * daemon 最近一次上报的 agent:status 内存缓存（owner -> agentName -> 运行态）：
 * members 快照（routes/channels.ts）用它作 presence 的运行时提示——刚打开页面的人
 * 立刻看到「工作中」，不必等 daemon 3s 上报器的下一次变化事件。
 * 不进库、重启即丢，由下一次上报重建；daemon 断连不清理——presence 合成有
 * computerOnline 否决（离线压过陈旧 working），多实例下只覆盖本实例所连 daemon。
 */
const lastAgentStatus = new Map<string, Map<string, string>>();

/** members 快照等读路径用：daemon 最近上报的运行态（无记录 → null） */
export function getLastAgentRuntime(ownerUserId: string, agentName: string): string | null {
  return lastAgentStatus.get(String(ownerUserId))?.get(agentName) ?? null;
}

/**
 * 终端观察目标解析 + 鉴权：返回被观察 agent 的 daemon 投递目标（machineKey 或 owner userId）。
 * 2026-09-17 审计 Q1：owner 本人，或（属主开关 allow_terminal_watch 开启时）与 agent
 * 共频道的人类成员（频道同事）。此前「频道同事」门槛可被零成本满足（公开频道自加入 /
 * 单方面建 DM），现加属主开关（默认关）——开关经 agent 档案 PATCH 端点由属主设置。
 * 2026-09-19：返回值从 owner userId 升级为投递目标——绑定机的 agent 的终端帧
 * （watch/unwatch/history/resize）必须精确路由到托管它的那台机器。
 */
async function resolveTerminalWatchTarget(
  watcherUserId: string,
  agentName: string,
): Promise<{ target: string; scope: string | null; isOwner: boolean } | null> {
  if (!wsPg) return null;
  try {
    const r = await wsPg.query<{
      user_id: string;
      server_id: string | null;
      computer_id: string | null;
      machine_uuid: string | null;
    }>(
      `SELECT a.user_id, a.server_id, a.computer_id, c.machine_uuid
         FROM agents a
         LEFT JOIN computers c ON c.id = a.computer_id
        WHERE a.name = $1 AND (
          a.user_id::text = $2
          OR (a.allow_terminal_watch = true AND EXISTS (
            SELECT 1 FROM channel_members cm1
            JOIN channel_members cm2 ON cm2.channel_id = cm1.channel_id
            WHERE cm1.member_id = a.id AND cm1.member_type = 'agent'
              AND cm2.member_id::text = $2 AND cm2.member_type = 'human')
          ))
        ORDER BY (a.user_id::text = $2) DESC
        LIMIT 1`,
      [agentName, watcherUserId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const uid = String(row.user_id);
    const scope = row.server_id ? String(row.server_id) : null;
    const target = row.machine_uuid ? `${uid}:${row.machine_uuid}` : (machineKeyForScope(uid, scope) ?? uid);
    return { target, scope, isOwner: uid === watcherUserId };
  } catch {
    return null;
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

  void resolveIdentity(token, isDaemon, clientIp, req)
    .then((ident) => {
      connection.off("message", bufferEarly);
      // daemon 令牌无效/被吊销 → resolveIdentity 返回 "anon"。明确用 4001 关闭，
      // 而不是把它当匿名 daemon 登记，否则 daemon 会误以为已连上并无限重连。
      // 浏览器 token 无效同样拒绝：此前降级为 "anon" 登记，导致未登录连接也能
      // 收到所有公开频道的消息广播（内容泄露）。统一按未授权关闭。
      if (ident === "anon") {
        if (isDaemon) {
          console.warn("[WS] Daemon auth failed (invalid/revoked machine token); closing with 4001");
        }
        try {
          connection.close(4001, "unauthorized");
        } catch {
          /* ignore */
        }
        return;
      }
      registerConnection(connection, ident, isDaemon);
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

/** 握手解析结果：daemon 带 token 的权威 server scope；浏览器无 scope（null） */
interface ResolvedIdentity {
  userId: string;
  serverId: string | null;
}

async function resolveIdentity(
  token: string | null,
  isDaemon: boolean,
  clientIp = "",
  req?: any,
): Promise<ResolvedIdentity | "anon"> {
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
      return v.ok ? { userId: v.userId, serverId: v.serverId } : "anon";
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
    return u ? { userId: u.userId, serverId: null } : "anon";
  } catch {
    return "anon"; // Invalid token — treat as anonymous browser client
  }
}

function registerConnection(connection: WebSocket, ident: ResolvedIdentity, isDaemon: boolean) {
  if (isDaemon) {
    const { userId, serverId } = ident;
    // ready 携 machineUuid 到达前挂 provisional 键——不顶任何人（多台机器可同时
    // 处于 pre-ready 窗口）；转正时同 machineKey 的旧连接才会被顶掉。
    // presence 注册推迟到 ready（成员串需要 machineUuid + serverId）。
    const pendingKey = `${userId}:~pending:${++pendingConnSeq}`;
    daemonClients.set(pendingKey, connection);
    daemonKeyOf.set(connection, pendingKey);
    // presence 连接即注册（临时成员 ~pending）——「daemon 在线」= 进程已连上，
    // 与旧版 register 即在线语义一致；ready 转正时换真成员串（含 machineUuid）。
    const pendingMember = `${userId}|~pending|${serverId}`;
    presenceAdd(pendingMember);
    daemonMeta.set(pendingKey, {
      userId,
      serverId,
      machineUuid: null,
      presenceMember: pendingMember,
      hostname: "unknown",
      daemonVersion: "?",
      runtimes: [],
      connectedAt: Date.now(),
    });
    console.log(`[WS] Daemon connected: user=${userId} server=${serverId}`);
    // P1.22：本实例持有该用户连接期间订阅其定向频道（多实例下按需扇出）
    refreshUserSubscription(userId);

    connection.on("message", (raw) => {
      try {
        // P1.28：运行时校验——非 JSON / 未知 type / 错型字段 → 整帧丢弃（限频 warn），
        // 校验通过的帧才进入 switch（字段类型得到保证，纵深防御）
        const msg = parseWsInbound(raw.toString(), wsFromDaemonSchema, "daemon");
        if (!msg) return;
        switch (msg.type) {
          case "ready": {
            const runtimes = normalizeRuntimes(msg.runtimes);
            // 缺省 machineUuid 的旧 daemon：合成 legacy-<userId> 单机身份——
            // 等价旧版一人一机单槽语义（同 user 第二连顶掉第一连）。
            const machineUuid =
              typeof msg.machineUuid === "string" && msg.machineUuid ? String(msg.machineUuid) : `legacy-${userId}`;
            const machineKey = `${userId}:${machineUuid}`;
            const curKey = daemonKeyOf.get(connection);
            if (curKey !== machineKey) {
              // 同 machineKey 已有别的活跃连接 → 顶掉（崩溃重连 / 换 scope 重跑：
              // 一台机器同时只持一条连接在场）
              const prev = daemonClients.get(machineKey);
              if (prev && prev !== connection) {
                try {
                  prev.close(4000, "superseded by same machine");
                } catch {
                  /* ignore */
                }
              }
              if (curKey) {
                daemonClients.delete(curKey);
                daemonMeta.delete(curKey);
              }
              daemonClients.set(machineKey, connection);
              daemonKeyOf.set(connection, machineKey);
            }
            const meta: DaemonMeta = daemonMeta.get(machineKey) ?? {
              userId,
              serverId,
              machineUuid,
              hostname: "unknown",
              daemonVersion: "?",
              runtimes: [],
              connectedAt: Date.now(),
            };
            meta.machineUuid = machineUuid;
            if (msg.hostname) meta.hostname = String(msg.hostname);
            if (msg.daemonVersion) meta.daemonVersion = String(msg.daemonVersion);
            meta.runtimes = runtimes;
            if (typeof msg.os === "string") meta.os = msg.os;
            if (typeof msg.arch === "string") meta.arch = msg.arch;
            daemonMeta.set(machineKey, meta);
            console.log(
              `[WS] Daemon ready: machine=${machineUuid} scope=${serverId} runtimes=${runtimes.map((r) => r.id).join(",")}`,
            );
            void finalizeDaemonReady(connection, meta, msg, runtimes);
            break;
          }
          case "agent:status":
            // 转发给该用户的浏览器（Agent 状态栏实时显示，G7 last_pty_line）
            sendToUser(userId, msg);
            // 落内存缓存：members 快照的 presence 运行时提示（getLastAgentRuntime）
            {
              let byAgent = lastAgentStatus.get(userId);
              if (!byAgent) {
                byAgent = new Map();
                lastAgentStatus.set(userId, byAgent);
              }
              byAgent.set(msg.agentName, msg.status);
            }
            // 频道同事补投：频道内其他成员的状态栏也实时反映「工作中/空闲」（此前只投
            // owner，非主人只能停在 members 快照层）。detail 是最后一行输出片段，可能
            // 含其它频道/DM 内容——非 owner 收件人在 sendAgentStatusToChannelPeers 内剥掉。
            void import("../lib/agent-duty.js").then(({ sendAgentStatusToChannelPeers }) =>
              sendAgentStatusToChannelPeers(wsPg, userId, msg),
            );
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
            // 观众集合挂在投递目标键（绑定机 machineKey）下——按本连接的注册键寻址，
            // 只有 agent 绑定的那台机器推帧才命中（同用户别的机器推同 agentName 不投）。
            const agentName = (msg as Record<string, unknown>).agentName as string | undefined;
            const connKey = daemonKeyOf.get(connection) ?? userId;
            if (agentName) publish({ kind: "terminal-frame", userId: connKey, agentName, event: msg });
            break;
          }
          case "terminal:obs-frame": {
            // B1 结构化观察帧：与 terminal:frame 同一条观众定向通道（按 agentName 引用计数）
            const agentName = (msg as Record<string, unknown>).agentName as string | undefined;
            const connKey = daemonKeyOf.get(connection) ?? userId;
            if (agentName) publish({ kind: "terminal-frame", userId: connKey, agentName, event: msg });
            break;
          }
          case "terminal:obs-history":
          case "terminal:history": {
            // daemon 回传的历史日志 / 观察帧 replay buffer → 发给该 agent 的观众集合
            // （观众含频道同事，socket 统一挂在投递目标键下；低频小负载，整集合投放）。
            // 无观众时退回 owner 全端兜底（面板已关但响应在途的旧行为）。
            const agentName = (msg as Record<string, unknown>).agentName as string | undefined;
            const connKey = daemonKeyOf.get(connection) ?? userId;
            const set = agentName ? terminalWatchers.get(connKey)?.get(agentName) : undefined;
            if (set && set.size > 0) deliver(set, JSON.stringify(msg));
            else sendToUser(userId, msg);
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
      const key = daemonKeyOf.get(connection);
      daemonKeyOf.delete(connection);
      const meta = key ? daemonMeta.get(key) : undefined;
      // 仅当本 socket 仍是该键的注册连接时才清槽——被同 machineKey 新连接顶掉的
      // 旧连接 close 迟到时不得误删新连接条目，也不得移除它刚注册的 presence 成员
      const stillOwner = key !== undefined && daemonClients.get(key) === connection;
      if (key && stillOwner) {
        daemonClients.delete(key);
        daemonMeta.delete(key);
      }
      // presence 成员在 register/ready 两处维护；断开按当前成员串移除（被顶者跳过）
      if (stillOwner && meta?.presenceMember) {
        presenceRemove(meta.presenceMember);
      }
      console.log(`[WS] Daemon disconnected: user=${userId} machine=${meta?.machineUuid ?? "pre-ready"}`);
      refreshUserSubscription(userId);
      void import("../lib/agent-duty.js").then(({ broadcastOwnerPresence }) => broadcastOwnerPresence(wsPg, userId));
    });

    attachHeartbeat(connection);
    connection.send(JSON.stringify({ type: "connected", serverTime: new Date().toISOString() }));
  } else {
    // Browser client
    const { userId } = ident;
    if (!browserClients.has(userId)) browserClients.set(userId, new Set());
    browserClients.get(userId)!.add(connection);
    // P1.22：本实例持有该用户连接期间订阅其定向频道（同用户多标签页共用一条订阅）
    refreshUserSubscription(userId);

    connection.on("message", (raw) => {
      try {
        // P1.28：运行时校验（同 daemon 分支）
        const msg = parseWsInbound(raw.toString(), wsFromBrowserSchema, "browser");
        if (!msg) return;
        if (msg.type === "pong") return;
        // 终端观察（G3）：浏览器请求观看/停止观看某个 agent 的终端
        if (msg.type === "terminal:watch" && typeof msg.agentName === "string") {
          // 终端观察（G3）：鉴权解析到被观察 agent 的 owner，观众 socket 挂 owner 键下、
          // watch 转发给 owner 的 daemon——此前挂自己键下发给自己的 daemon，频道同事
          // 永远看不到他人 agent 的终端
          void resolveTerminalWatchTarget(userId, msg.agentName).then((t) => {
            if (t) addTerminalWatcher(t.target, msg.agentName, connection, t.scope);
          });
        } else if (msg.type === "terminal:unwatch" && typeof msg.agentName === "string") {
          // 观众 socket 可能挂在他人 owner 键下——按反向索引找，不假定是自己名下
          for (const w of socketWatches.get(connection) ?? []) {
            if (w.agentName === msg.agentName) removeTerminalWatcher(w.owner, w.agentName, connection);
          }
        } else if (msg.type === "terminal:history" && typeof msg.agentName === "string") {
          // 历史日志请求：鉴权后转发给 owner 的 daemon（响应发给该 agent 的观众集合，
          // 见 daemon 分支 terminal:history 的观众定向）
          void resolveTerminalWatchTarget(userId, msg.agentName).then((t) => {
            if (t) sendToDaemon(t.target, { type: "terminal:history", agentName: msg.agentName }, { scope: t.scope });
          });
        } else if (msg.type === "terminal:resize" && typeof msg.agentName === "string") {
          // 面板尺寸协商：浏览器把期望的 cols/rows 转发给 daemon（实时 resize PTY）。
          // resize 是主动控制（改对方 PTY 尺寸 + 记偏好尺寸），仅限 owner——观察只读。
          // isOwner 由解析返回（target 可能是 machineKey，不能直接和 userId 比）
          void resolveTerminalWatchTarget(userId, msg.agentName).then((t) => {
            if (t?.isOwner) {
              sendToDaemon(
                t.target,
                {
                  type: "terminal:resize",
                  agentName: msg.agentName,
                  cols: msg.cols,
                  rows: msg.rows,
                },
                { scope: t.scope },
              );
            }
          });
        }
      } catch {
        /* ignore */
      }
    });

    connection.on("close", () => {
      browserClients.get(userId)?.delete(connection);
      removeTerminalWatcherSocket(connection);
      refreshUserSubscription(userId);
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

/**
 * ready 后的异步收口：
 * 1. `--server` 声明校验（可选）：daemon 声明的 server 名与 token scope 实际名
 *    不一致 → 拒连（拿错 token 立刻报，不静默连错 server；token 仍是唯一权威 scope）
 * 2. presence 注册（成员串 `userId|machineUuid|serverId`——三维在线身份）
 * 3. persistComputerReady：upsert (user, server, machine) 行
 */
async function finalizeDaemonReady(
  connection: WebSocket,
  meta: DaemonMeta,
  msg: { serverName?: unknown; hostname?: unknown; os?: unknown; arch?: unknown; daemonVersion?: unknown },
  runtimes: RuntimeProbe[],
): Promise<void> {
  const { userId, serverId, machineUuid } = meta;
  if (typeof msg.serverName === "string" && msg.serverName && wsPg && serverId) {
    try {
      const r = await wsPg.query<{ name: string }>("SELECT name FROM servers WHERE id = $1", [serverId]);
      const actual = r.rows[0]?.name;
      if (actual && actual !== msg.serverName) {
        console.warn(`[WS] daemon --server mismatch: declared="${msg.serverName}" token scope="${actual}" — closing`);
        try {
          connection.close(4001, "server scope mismatch");
        } catch {
          /* ignore */
        }
        return;
      }
    } catch {
      /* 校验查询失败不阻断（name 比对只是防御性检查） */
    }
  }
  // presence 转正：临时成员（~pending）换真成员串（含 machineUuid）
  if (serverId && machineUuid) {
    const member = `${userId}|${machineUuid}|${serverId}`;
    if (meta.presenceMember !== member) {
      if (meta.presenceMember) presenceRemove(meta.presenceMember);
      meta.presenceMember = member;
      presenceAdd(member);
    }
  }
  persistComputerReady(userId, serverId, machineUuid ?? `legacy-${userId}`, {
    hostname: typeof msg.hostname === "string" ? msg.hostname : undefined,
    os: typeof msg.os === "string" ? msg.os : undefined,
    arch: typeof msg.arch === "string" ? msg.arch : undefined,
    daemonVersion: typeof msg.daemonVersion === "string" ? msg.daemonVersion : undefined,
    runtimes,
  });
  void import("../lib/agent-duty.js").then(({ broadcastOwnerPresence }) => broadcastOwnerPresence(wsPg, userId));
}

/**
 * (user, server, machine) 三维 upsert——computers 行只在 daemon ready 时写。
 * serverId 来自 token scope（非请求方指定）；用户已不在该 server（token 是旧签的）
 * → 不写库。上报真 uuid 且 (user,server) 只有迁移占位行（legacy-<id>）时原地回填。
 */
function persistComputerReady(
  userId: string,
  serverId: string | null,
  machineUuid: string,
  probe: { hostname?: string; os?: string; arch?: string; daemonVersion?: string; runtimes?: RuntimeProbe[] },
): void {
  if (!wsPg || !serverId) return;
  const hostname = probe.hostname ? String(probe.hostname) : null;
  const os = probe.os ? String(probe.os) : null;
  const arch = probe.arch ? String(probe.arch) : null;
  const daemonVersion = probe.daemonVersion ? String(probe.daemonVersion) : null;
  const name = (hostname && hostname !== "unknown" ? hostname : "我的计算机").slice(0, 80);
  void (async () => {
    try {
      const mem = await wsPg!.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2", [
        serverId,
        userId,
      ]);
      if (mem.rows.length === 0) {
        console.warn(`[WS] persist computer ready skipped: user=${userId} not a member of server=${serverId}`);
        return;
      }
      // 占位回填：存量迁移行 machine_uuid='legacy-<id>' 视为「已注册待认主」——
      // 首个上报真 uuid 的机器原地认领（不产生第二行）。
      if (!machineUuid.startsWith("legacy-")) {
        const claimed = await wsPg!.query<{ id: string }>(
          `UPDATE computers SET
             machine_uuid = $3,
             hostname = COALESCE($4, hostname),
             os = COALESCE($5, os),
             arch = COALESCE($6, arch),
             daemon_version = COALESCE($7, daemon_version),
             runtimes = $8::jsonb,
             last_ready_at = now()
           WHERE user_id::text = $1 AND server_id::text = $2 AND machine_uuid LIKE 'legacy-%'
             AND NOT EXISTS (
               SELECT 1 FROM computers
               WHERE user_id::text = $1 AND server_id::text = $2 AND machine_uuid = $3
             )
           RETURNING id`,
          [userId, serverId, machineUuid, hostname, os, arch, daemonVersion, JSON.stringify(probe.runtimes ?? [])],
        );
        if (claimed.rows.length > 0) return;
      }
      await wsPg!.query(
        `INSERT INTO computers (user_id, server_id, machine_uuid, name, description, hostname, os, arch, daemon_version, runtimes, last_ready_at)
         VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, $9::jsonb, now())
         ON CONFLICT (user_id, server_id, machine_uuid) DO UPDATE SET
           hostname = COALESCE(EXCLUDED.hostname, computers.hostname),
           os = COALESCE(EXCLUDED.os, computers.os),
           arch = COALESCE(EXCLUDED.arch, computers.arch),
           daemon_version = COALESCE(EXCLUDED.daemon_version, computers.daemon_version),
           runtimes = EXCLUDED.runtimes,
           last_ready_at = now()`,
        [userId, serverId, machineUuid, name, hostname, os, arch, daemonVersion, JSON.stringify(probe.runtimes ?? [])],
      );
    } catch (err) {
      console.warn("[WS] persist computer ready failed:", (err as Error)?.message ?? err);
    }
  })();
}

/**
 * 按频道定向广播：
 * - 公开频道：投递给所有浏览器连接 + 所有 daemon（@提及自动入圈依赖广播面）。
 * - 私有频道/DM：浏览器端只投递给该频道的人类成员；daemon 端只投给「其 agent 是
 *   频道成员」的用户（agent 派发只需要 agent 成员；人类成员的 daemon 不需要频道明文
 *   ——P1.22 收敛，此前所有用户 daemon 都能收到他人私有频道内容）。
 * channelId 传频道 UUID。
 *
 * P0.2 fail-closed：频道类型/成员解析失败（DB 抖动、频道不存在、类型未知）时放弃广播，
 * 不再退回全发——否则 DB 抖动窗口内私有频道/DM 的明文事件会广播给全部浏览器（内容泄露）。
 * 代价是抖动窗口内丢事件，但消息可经 REST 按 seq 游标补拉恢复，安全优先于送达。
 * P1.22 起 agent 成员归属查询同属解析环节：查询失败同样整体丢弃（daemon 维度绝不退回全发）。
 *
 * O1：改为跨实例 pub/sub —— 本实例解析完成员后，把「信封」发布到 Valkey channel，
 * 每个实例（含本实例）订阅后按各自的本地 socket 表投递。多实例部署时实例间不再互相看不见。
 */
export async function broadcast(channelId: string, event: WsChannelBroadcast) {
  let allowedHumanIds: string[] | null = null; // null = 不限制（公开）
  let allowedDaemonUserIds: string[] | null = null; // null = daemon 不限制（公开频道全发）
  let channelServerId: string | null = null; // daemon 扇出的 scope 过滤键
  let resolved = false;
  try {
    if (wsPg && channelId) {
      const ch = await wsPg.query<{ type: string; server_id: string }>(
        "SELECT type, server_id::text AS server_id FROM channels WHERE id = $1",
        [channelId],
      );
      const t = ch.rows[0]?.type;
      channelServerId = ch.rows[0]?.server_id ?? null;
      if (t === "private" || t === "dm") {
        // 私有频道与 DM 都按成员定向：仅其人类成员的浏览器收到
        const m = await wsPg.query<{ member_id: string }>(
          "SELECT member_id FROM channel_members WHERE channel_id = $1 AND member_type = 'human'",
          [channelId],
        );
        allowedHumanIds = m.rows.map((r) => String(r.member_id));
        // daemon 侧收敛（P1.22）：channel_members 的 agent 成员（member_id=agents.id）
        // JOIN agents 拿 owner user_id——daemonClients 按 owner userId 记账。
        const owners = await wsPg.query<{ user_id: string }>(
          `SELECT DISTINCT a.user_id FROM channel_members cm
           JOIN agents a ON cm.member_id = a.id AND cm.member_type = 'agent'
           WHERE cm.channel_id = $1`,
          [channelId],
        );
        allowedDaemonUserIds = owners.rows.map((r) => String(r.user_id));
        resolved = true;
      } else if (t === "public") {
        // 2026-09-17 审计收紧：公开频道扇出不再「全体已登录浏览器/daemon」——
        // 改为「频道所在 server 成员 ∪ 频道人类/agent 成员」（与 canAccessChannel
        // 收紧口径一致；管理员邀请入圈的跨社区成员仍可达；跨社区浏览器与
        // daemon 不再收到本社区公开频道明文）。
        if (!channelServerId) {
          resolved = false;
        } else {
          const sm = await getServerMemberIdSet(wsPg, channelServerId);
          const cm = await wsPg.query<{ member_id: string; user_id: string | null }>(
            `SELECT cm.member_id, a.user_id FROM channel_members cm
             LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
             WHERE cm.channel_id = $1`,
            [channelId],
          );
          const humanIds = new Set<string>(sm);
          const daemonIds = new Set<string>(sm);
          for (const row of cm.rows) {
            if (!row.user_id) humanIds.add(String(row.member_id)); // 人类成员（agent 行的 member_id 是 agents.id）
            if (row.user_id) daemonIds.add(String(row.user_id)); // agent 成员 → 其属主 daemon
          }
          allowedHumanIds = [...humanIds];
          allowedDaemonUserIds = [...daemonIds];
          resolved = true;
        }
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

  publish({ kind: "channel", channelId, serverId: channelServerId, allowedHumanIds, allowedDaemonUserIds, event });
}

/**
 * 投递到指定 daemon。target 可为 machineKey（`userId:machineUuid`，精确到机器）
 * 或 userId（兼容旧调用方：解析为该用户任一连接——单机场景等价旧行为）。
 * agent 级事件的调用方应逐步迁移为传 agent.computer_id 解析出的 machineKey。
 */
export function sendToDaemon(target: string, event: WsToDaemonMessage, opts?: { scope?: string | null }) {
  publish({ kind: "daemon", target, scope: opts?.scope ?? null, event });
}

/** 属主在指定 server scope 的在线连接键——多机时按 scope 区分（daemonMeta 扫描） */
export function machineKeyForScope(userId: string, serverId: string | null | undefined): string | null {
  const sid = serverId ?? null;
  for (const [key, meta] of daemonMeta) {
    if (meta.userId === String(userId) && meta.serverId === sid) return key;
  }
  return null;
}

type AgentIdentity = { user_id?: unknown; server_id?: unknown; computer_id?: unknown };
type PgQueryable = {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

/**
 * agent 级事件的投递目标解析（server-scoped computers，2026-09-19 设计稿 §3.2）：
 * - 已绑定（agents.computer_id）→ 该计算机行的 machineKey（`u:machine_uuid`）精确到机器；
 * - 未绑定（存量 NULL）→ 属主在同 scope 的连接，再没有则属主任一连接（旧行为兜底）。
 * 解析失败/行缺失时回落 unbound 分支，绝不静默错投其他 scope。
 */
export async function daemonTargetForAgent(pg: PgQueryable, agent: AgentIdentity): Promise<string> {
  const uid = String(agent.user_id);
  if (agent.computer_id) {
    const r = await pg
      .query<{ machine_uuid: string }>("SELECT machine_uuid FROM computers WHERE id = $1", [String(agent.computer_id)])
      .catch(() => ({ rows: [] as { machine_uuid: string }[] }));
    const m = r.rows[0]?.machine_uuid;
    if (m) return `${uid}:${m}`;
  }
  return machineKeyForScope(uid, agent.server_id ? String(agent.server_id) : null) ?? uid;
}

/** agent 绑定机的在线判定（与 daemonTargetForAgent 同解析口径）：bound → isMachineOnline；unbound → scope 在线 or 任一在线（legacy） */
export async function agentMachineOnline(pg: PgQueryable, agent: AgentIdentity): Promise<boolean> {
  const uid = String(agent.user_id);
  if (agent.computer_id) {
    const r = await pg
      .query<{ machine_uuid: string; server_id: string }>(
        "SELECT machine_uuid, server_id FROM computers WHERE id = $1",
        [String(agent.computer_id)],
      )
      .catch(() => ({ rows: [] as { machine_uuid: string; server_id: string }[] }));
    const row = r.rows[0];
    if (row) return isMachineOnline(uid, row.machine_uuid, String(row.server_id));
  }
  const sid = agent.server_id ? String(agent.server_id) : null;
  if (sid && isUserScopeOnline(uid, sid)) return true;
  return isComputerOnline(uid);
}

/** agent 级事件的统一投递入口：解析绑定机目标 + 带 scope 守护发送（调用方不再手拼 machineKey） */
export async function sendToAgentDaemon(
  pg: PgQueryable,
  agent: AgentIdentity,
  event: WsToDaemonMessage,
): Promise<void> {
  const target = await daemonTargetForAgent(pg, agent);
  sendToDaemon(target, event, { scope: agent.server_id ? String(agent.server_id) : null });
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

/** 向本机 daemon 要工作区文件；daemon 离线或超时返回 null。target=machineKey/userId；scope 限定连接 scope */
export function requestDaemonWorkspace(
  target: string,
  agentName: string,
  path?: string,
  timeoutMs = 4000,
  opts?: { scope?: string | null },
): Promise<WorkspaceResult | null> {
  const scope = opts?.scope ?? null;
  if (scope) {
    // scope 投递前的轻量预检：存在「target 命中且连接 scope 相符」才发送（与 handleEnvelope 同口径）
    const keys = target.includes(":")
      ? [target]
      : [...daemonClients.keys()].filter((k) => k === target || k.startsWith(`${target}:`));
    const ok = keys.some((k) => daemonClients.has(k) && daemonMeta.get(k)?.serverId === scope);
    if (!ok) return Promise.resolve(null);
  } else if (!resolveDaemonConn(target)) {
    return Promise.resolve(null);
  }
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
      target,
      path ? { type: "workspace:read", requestId, agentName, path } : { type: "workspace:read", requestId, agentName },
      { scope },
    );
  });
}

/**
 * 2026-09-17 审计 Q1 配套：终端观看权是 watch 时一次性判定，成员变更后长连帧流
 * 不会自动中断。本函数在频道成员变更（移出/退出/频道删除）时被调用，对每个仍在
 * 观看非自有 agent 的观众重跑 resolveTerminalWatchTarget，不再有权者立即摘除。
 */
export async function revalidateTerminalWatchersByChannel(channelId: string): Promise<void> {
  if (!wsPg || terminalWatchers.size === 0) return;
  const members = await wsPg
    .query<{ name: string }>(
      `SELECT a.name FROM channel_members cm
       JOIN agents a ON cm.member_id = a.id AND cm.member_type = 'agent'
       WHERE cm.channel_id = $1`,
      [channelId],
    )
    .catch(() => ({ rows: [] as { name: string }[] }));
  // 行空（频道已删/无 agent 成员）→ 不提前返回：复核所有观看者（低频操作，多复核无害）
  for (const [owner, byAgent] of terminalWatchers) {
    for (const agentName of [...byAgent.keys()]) {
      // 该 agent 不在被变更的频道里 → 其观看权与本次变更无关，跳过
      const isMemberHere = members.rows.some((r) => r.name === agentName);
      if (!isMemberHere) continue;
      for (const ws of [...(byAgent.get(agentName) ?? [])]) {
        const watcherId = socketOwnerOf(ws);
        // owner 恒有权——owner 键可能是 machineKey（`u:uuid`），前缀比较兼容两种键形
        if (!watcherId || watcherId === owner || owner.startsWith(`${watcherId}:`)) continue;
        const stillAllowed = await resolveTerminalWatchTarget(watcherId, agentName);
        if (!stillAllowed) removeTerminalWatcher(owner, agentName, ws);
      }
    }
  }
}

/** 观众 socket → 其登录 userId：browserClients 反查（观看复核低频，O(n) 可接受） */
function socketOwnerOf(ws: WebSocket): string | null {
  for (const [uid, set] of browserClients) {
    if (set.has(ws)) return uid;
  }
  return null;
}

/** Send a message to a specific user's browser clients */
export function sendToUser(userId: string, event: WsToBrowserMessage) {
  publish({ kind: "user", userId, event });
}

// ---------- 跨实例 pub/sub（O1；P1.22 按事件形态/userId 分频道） ----------
// 两个频道族：
// - 广播面（全局订阅）：频道事件 + all-daemons——目标 socket 可能挂在任何实例上；
// - 定向面（按 userId 动态订/退）：user / daemon / terminal-frame 只与本实例持有的
//   连接相关——多实例下高频 terminal-frame 与定向事件不再对全部实例全量扇出。
const PUBSUB_CHANNEL_BROADCAST = "slock:ws:v1:channel";
const PUBSUB_CHANNEL_ALL_DAEMONS = "slock:ws:v1:all";
const userChannelName = (userId: string) => `slock:ws:v1:u:${userId}`;

type WsEnvelope =
  | {
      kind: "channel";
      channelId: string;
      /** 频道所在 server——daemon 扇出的 scope 过滤键（连错 scope 的机器不投递） */
      serverId: string | null;
      allowedHumanIds: string[] | null;
      allowedDaemonUserIds: string[] | null;
      event: any;
    }
  | { kind: "user"; userId: string; event: any }
  // target=machineKey 或 userId；scope=期望的 server scope（null=不校验）——
  // agent 级事件必带 scope：绑定机当前连了别的 server 时绝不误投（投递层隔离）
  | { kind: "daemon"; target: string; scope?: string | null; event: any }
  | { kind: "all-daemons"; event: any }
  | { kind: "terminal-frame"; userId: string; agentName: string; event: any };

let pubsub: PubSub | null = null;
// 本实例已订阅的定向频道（unsub 句柄按 userId 记账；随本地连接增减动态订/退）
const userSubs = new Map<string, () => void>();

function envelopeChannel(env: WsEnvelope): string {
  switch (env.kind) {
    case "channel":
      return PUBSUB_CHANNEL_BROADCAST;
    case "all-daemons":
      return PUBSUB_CHANNEL_ALL_DAEMONS;
    case "daemon":
      // target 可为 machineKey（userId:machineUuid）——定向频道仍按 userId 分，
      // 接收实例在本地 socket 表上再按 machineKey/scope 精确解析
      return userChannelName(env.target.split(":")[0]!);
    case "terminal-frame":
      // userId 字段承载发布连接的注册键（可为 machineKey）——订阅频道按 userId 分，
      // 本地观众表才按完整键寻址
      return userChannelName(env.userId.split(":")[0]!);
    default:
      return userChannelName(env.userId);
  }
}

/** 本实例持有该用户的连接（browser 或 daemon）才需要订阅其定向频道；幂等，连接增减处调用 */
function refreshUserSubscription(userId: string): void {
  if (!pubsub) return;
  const needed = browserClients.has(userId) || userHasLocalDaemon(userId);
  if (needed && !userSubs.has(userId)) {
    userSubs.set(
      userId,
      pubsub.subscribe(userChannelName(userId), (payload) => handleEnvelope(payload as WsEnvelope)),
    );
  } else if (!needed && userSubs.has(userId)) {
    userSubs.get(userId)!();
    userSubs.delete(userId);
  }
}

/** 由 index.ts 启动时注入 pubsub 实例并订阅广播面频道。 */
export function setPubSub(p: PubSub): void {
  // 重复注入（测试）：先摘掉旧实例上的全部定向订阅，避免句柄悬空
  if (pubsub) for (const unsub of userSubs.values()) unsub();
  userSubs.clear();
  pubsub = p;
  p.subscribe(PUBSUB_CHANNEL_BROADCAST, (payload) => handleEnvelope(payload as WsEnvelope));
  p.subscribe(PUBSUB_CHANNEL_ALL_DAEMONS, (payload) => handleEnvelope(payload as WsEnvelope));
  // 已在线用户的定向频道补订阅（进程重启后 setPubSub 晚于首条连接 / 测试重复注入）
  for (const userId of new Set([...browserClients.keys(), ...localDaemonUserIds()])) {
    refreshUserSubscription(userId);
  }
}

function publish(env: WsEnvelope): void {
  // pubsub 尚未注入（模块极早期）→ 本地直投兜底，避免消息凭空消失
  if (pubsub) pubsub.publish(envelopeChannel(env), env);
  else handleEnvelope(env);
}

// P1.22 慢消费者背压：裸 send 不看 bufferedAmount，高频帧（terminal-frame）对慢客户端
// 会无限积压在发送缓冲。超阈值说明对端已跟不上，直接 terminate 逼其重连并按 seq
// 游标走 REST 补拉——静默跳过会丢消息且不可察觉，断开重连反而是可恢复路径。
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

/** 导出供背压单测（P1.22）：超阈值 terminate，正常 send */
export function deliver(sockets: Iterable<WebSocket>, payload: string): void {
  for (const ws of sockets) {
    try {
      if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
        inc("wsSlowConsumerTerminated");
        console.warn(`[WS] slow consumer (buffered=${ws.bufferedAmount}B), terminating to force reconnect+backfill`);
        ws.terminate();
        continue;
      }
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
      // P1.22：daemon 不再无条件全发（此前所有用户 daemon 都能收到他人私有频道明文）——
      // 公开频道全发（@提及自动入圈依赖广播面）；私有频道/DM 仅投给「其 agent 是频道
      // 成员」的用户 daemon。成员解析在 broadcast() 完成；解析失败 fail-closed 为空数组
      // → 不投任何 daemon（与 P0.2 同语义，事件可经 REST 按 seq 游标补拉）。
      const daemonAllowed = env.allowedDaemonUserIds ? new Set(env.allowedDaemonUserIds) : null;
      for (const [key, ws] of daemonClients) {
        const meta = daemonMeta.get(key);
        const uid = meta?.userId ?? key.split(":")[0]!;
        if (daemonAllowed && !daemonAllowed.has(uid)) continue;
        // scope 过滤（server-scoped computers）：连接只收自己 token scope server 的
        // 频道事件——scope 不符（连了别的 server）或尚未 ready（serverId 未就位
        // 时 meta.serverId 已有 token scope，provisional 连接同样受过滤）
        if (env.serverId && meta?.serverId !== env.serverId) continue;
        deliver([ws], payload);
      }
      break;
    }
    case "user": {
      const sockets = browserClients.get(env.userId);
      if (sockets) deliver(sockets, JSON.stringify(env.event));
      break;
    }
    case "daemon": {
      let daemon: WebSocket | undefined;
      if (env.scope) {
        // scope 守护：只投给「当前 scope 相符」的连接。target=machineKey 时校验该机
        // 连接的 scope；target=裸 userId 时在该用户的连接里挑同 scope 的一条——
        // 机器已切到其他 server 时宁可不投也不误投（隔离语义）。
        const candidates = env.target.includes(":")
          ? [env.target]
          : [...daemonClients.keys()].filter((k) => k === env.target || k.startsWith(`${env.target}:`));
        for (const k of candidates) {
          const ws = daemonClients.get(k);
          if (!ws) continue;
          if (daemonMeta.get(k)?.serverId === env.scope) {
            daemon = ws;
            break;
          }
        }
      } else {
        daemon = resolveDaemonConn(env.target);
      }
      if (daemon) deliver([daemon], JSON.stringify(env.event));
      break;
    }
    case "all-daemons": {
      deliver(daemonClients.values(), JSON.stringify(env.event));
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
