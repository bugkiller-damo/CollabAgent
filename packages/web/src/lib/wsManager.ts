import type { WsClientMessage, WsServerMessage } from "@collabagent/shared";

/**
 * 单一 WS 管理模块（O16）——收敛连接生命周期：连接/心跳/重连/看门狗/发送/事件订阅。
 *
 * 之前分散在三处：composables/useWebSocket.ts（生命周期，绑组件 onMounted）、
 * stores/wsSender.ts（模块级发送器）、AppLayout.vue（onMessage switch + 状态同步）。
 * 现在：本模块管生命周期与发送（框架无关、可注入 socket 工厂单测），
 * wsDispatch.ts 管事件路由，AppLayout 只做组装（init + start/stop）。
 *
 * 设计对照 buzz desktop 的 relay 客户端分层（relayReconnectPolicy 纯函数决策 +
 * relayStallWatchdog + session orchestrator）——slock 规模下收敛为单模块 +
 * 依赖注入，保留同等可测性。
 *
 * 多标签页说明：多开标签页会各自持有一条 WS 连接（server 端无害）。重连补拉
 * 幂等（消息按 id 去重），离线队列补发幂等（clientNonce 服务端去重），
 * 唯一缺口是标签页间 pending 队列内存态不同步（localStorage 已持久化的部分
 * 各自可见）——如需严格一致可加 BroadcastChannel leader 选举，暂列后续项。
 */

export type WsConnStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/** 结构化最小 WebSocket 接口（测试用 fake 注入） */
export interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WsManagerOptions {
  /** 完整 ws(s):// URL（调用方负责 http→ws 转换） */
  url: string;
  /** 业务事件出口（ping/pong 不经过这里） */
  onEvent: (msg: WsServerMessage) => void;
  /** 连接状态变化（同步 uiStore） */
  onStatus?: (status: WsConnStatus, reconnectAttempt: number) => void;
  /** 连接建立。isReconnect=false 为首连；=true 为断线重连（调用方据此触发补拉） */
  onConnect?: (isReconnect: boolean) => void;
  /** 测试注入：替换 WebSocket 构造 */
  createSocket?: (url: string) => WebSocketLike;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  inboundWatchdogMs?: number;
}

export interface WsManager {
  start(): void;
  stop(): void;
  send(msg: WsClientMessage | Record<string, unknown>): void;
  isConnected(): boolean;
}

const WS_OPEN = 1; // WebSocket.OPEN（node 测试环境无全局 WebSocket 常量）

export function createWsManager(opts: WsManagerOptions): WsManager {
  const {
    url,
    onEvent,
    onStatus,
    onConnect,
    minReconnectDelayMs = 1000,
    maxReconnectDelayMs = 30000,
    inboundWatchdogMs = 70000,
  } = opts;
  const createSocket = opts.createSocket ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);

  let ws: WebSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = minReconnectDelayMs;
  let reconnectAttempt = 0;
  let shouldConnect = false;
  let hasDisconnected = false; // 首连不算重连（onConnect(false)）

  const emitStatus = (s: WsConnStatus) => onStatus?.(s, reconnectAttempt);

  const clearTimers = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      console.warn(`[wsManager] No inbound traffic for ${inboundWatchdogMs / 1000}s, forcing reconnect`);
      ws?.close();
    }, inboundWatchdogMs);
  };

  const scheduleReconnect = () => {
    if (!shouldConnect || reconnectTimer) return;
    reconnectAttempt += 1;
    emitStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelayMs);
  };

  const connect = () => {
    if (!shouldConnect) return;
    if (ws?.readyState === WS_OPEN) return;

    const sock = createSocket(url);
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock || !shouldConnect) return;
      reconnectAttempt = 0;
      reconnectDelay = minReconnectDelayMs;
      resetWatchdog();
      emitStatus("connected");
      onConnect?.(hasDisconnected);
    };

    sock.onmessage = (event) => {
      if (ws !== sock) return;
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        resetWatchdog();
        if ((msg as { type?: string }).type === "ping") {
          sock.send(JSON.stringify({ type: "pong" }));
        } else {
          onEvent(msg);
        }
      } catch {
        console.error("[wsManager] Invalid message");
      }
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      hasDisconnected = true;
      if (shouldConnect) {
        scheduleReconnect();
      } else {
        emitStatus("disconnected");
      }
    };

    sock.onerror = (err) => {
      console.error("[wsManager] Error", err);
    };
  };

  return {
    start() {
      if (shouldConnect) return; // 幂等
      shouldConnect = true;
      reconnectAttempt = 0;
      emitStatus("connecting");
      connect();
    },
    stop() {
      shouldConnect = false;
      clearTimers();
      ws?.close();
      ws = null;
      emitStatus("disconnected");
    },
    send(msg) {
      if (ws?.readyState === WS_OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    isConnected() {
      return ws?.readyState === WS_OPEN;
    },
  };
}

// ---- 模块级单例（O16 收敛点）：应用内唯一 WS 连接句柄 ----
// AppLayout 负责 init + start/stop；业务侧（终端观察等）一律经 wsSend 发送，
// 不再经 stores/wsSender.ts 的全局可变 sender（已删除）。

let current: WsManager | null = null;

export function initWsManager(opts: WsManagerOptions): WsManager {
  current?.stop();
  current = createWsManager(opts);
  return current;
}

export function getWsManager(): WsManager | null {
  return current;
}

export function teardownWsManager(): void {
  current?.stop();
  current = null;
}

/** 业务侧发送入口：未初始化/未连接时静默丢弃（与旧 wsSender 语义一致） */
export function wsSend(msg: Record<string, unknown>): void {
  current?.send(msg);
}
