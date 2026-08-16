import type { WsClientMessage, WsServerMessage } from "@collabagent/shared";
import { onMounted, onUnmounted, type Ref, ref } from "vue";

interface UseWebSocketOptions {
  serverUrl: string;
  token: string;
  onMessage: (msg: WsServerMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  inboundWatchdogMs?: number;
}

interface UseWebSocketReturn {
  isConnected: Ref<boolean>;
  reconnectAttempt: Ref<number>;
  send: (msg: WsClientMessage) => void;
}

/**
 * WebSocket 连接管理 —— 从 packages/web/src/hooks/useWebSocket.ts 移植。
 * 行为与 React 版完全一致：
 * - URL 拼接：http(s) → ws(s) + /ws/chat
 * - onmessage JSON.parse；type==="ping" 自动回 pong（不触发 onMessage）
 * - 入站看门狗（默认 70s）：任何合法入站消息（含 ping）都重置；超时强制 close 触发重连
 * - 重连退避：1s 起步 ×2，封顶 30s；onopen 时归零
 * - 组件卸载即 disconnect（shouldConnect=false，不再重连）
 *
 * Vue 化差异：
 * - isConnected/reconnectAttempt 为 Ref（React 版为 useState 值），send 签名不变
 * - onMounted/onUnmounted 替代 useEffect(..., [])
 * - 回调在 setup 时捕获一次（React 版用 ref 每次渲染刷新回调）；token 仅在 React 版
 *   的 useCallback deps 中起作用（URL 构造并未用到它——浏览器端靠 Cookie 鉴权），
 *   本移植保留该入参以维持签名，但 token 变化不会触发重连，如需换 token 请 remount 组件
 */
export function useWebSocket({
  serverUrl,
  token,
  onMessage,
  onConnect,
  onDisconnect,
  minReconnectDelayMs = 1000,
  maxReconnectDelayMs = 30000,
  inboundWatchdogMs = 70000,
}: UseWebSocketOptions): UseWebSocketReturn {
  const isConnected = ref(false);
  const reconnectAttempt = ref(0);

  // 非响应式连接态（对应 React 版的 useRef 们）：闭包变量即可，组件实例存续期间有效
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = minReconnectDelayMs;
  let shouldConnect = true;

  void token; // 签名对齐用，见上方注释

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
      console.warn(`[WebSocket] No inbound traffic for ${inboundWatchdogMs / 1000}s, forcing reconnect`);
      ws?.close();
    }, inboundWatchdogMs);
  };

  const scheduleReconnect = () => {
    if (!shouldConnect) return;
    if (reconnectTimer) return;
    reconnectAttempt.value += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelayMs);
  };

  const connect = () => {
    if (!shouldConnect) return;
    if (ws?.readyState === WebSocket.OPEN) return;

    const wsUrl = serverUrl.replace(/^http/, "ws") + `/ws/chat`;
    const sock = new WebSocket(wsUrl);
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock || !shouldConnect) return;
      isConnected.value = true;
      reconnectAttempt.value = 0;
      reconnectDelay = minReconnectDelayMs;
      resetWatchdog();
      onConnect?.();
    };

    sock.onmessage = (event) => {
      if (ws !== sock) return;
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        resetWatchdog();
        if (msg.type !== "ping") {
          onMessage(msg);
        } else {
          sock.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        console.error("[WebSocket] Invalid message");
      }
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      isConnected.value = false;
      onDisconnect?.();
      scheduleReconnect();
    };

    sock.onerror = (err) => {
      console.error("[WebSocket] Error", err);
    };
  };

  const disconnect = () => {
    shouldConnect = false;
    clearTimers();
    ws?.close();
    ws = null;
    isConnected.value = false;
  };

  const send = (msg: WsClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  onMounted(() => {
    shouldConnect = true;
    connect();
  });
  onUnmounted(() => {
    disconnect();
  });

  return { isConnected, reconnectAttempt, send };
}
