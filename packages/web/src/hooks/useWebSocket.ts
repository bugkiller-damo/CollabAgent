import { useEffect, useRef, useCallback, useState } from "react";
import type { WsServerMessage, WsClientMessage } from "@collabagent/shared";

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
  isConnected: boolean;
  reconnectAttempt: number;
  send: (msg: WsClientMessage) => void;
}

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
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(minReconnectDelayMs);
  const shouldConnectRef = useRef(true);
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  onMessageRef.current = onMessage;
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const resetWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
    watchdogTimerRef.current = setTimeout(() => {
      console.warn(`[WebSocket] No inbound traffic for ${inboundWatchdogMs / 1000}s, forcing reconnect`);
      wsRef.current?.close();
    }, inboundWatchdogMs);
  }, [inboundWatchdogMs]);

  const scheduleReconnect = useCallback(() => {
    if (!shouldConnectRef.current) return;
    if (reconnectTimerRef.current) return;
    setReconnectAttempt((n) => n + 1);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, reconnectDelayRef.current);
    reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, maxReconnectDelayMs);
  }, [maxReconnectDelayMs]);

  const connect = useCallback(() => {
    if (!shouldConnectRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const wsUrl = serverUrl.replace(/^http/, "ws") + `/daemon/connect?key=${token}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws || !shouldConnectRef.current) return;
      setIsConnected(true);
      setReconnectAttempt(0);
      reconnectDelayRef.current = minReconnectDelayMs;
      resetWatchdog();
      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        resetWatchdog();
        if (msg.type !== "ping") {
          onMessageRef.current(msg);
        } else {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        console.error("[WebSocket] Invalid message");
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setIsConnected(false);
      onDisconnectRef.current?.();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error("[WebSocket] Error", err);
    };
  }, [serverUrl, token, minReconnectDelayMs, resetWatchdog, scheduleReconnect]);

  const disconnect = useCallback(() => {
    shouldConnectRef.current = false;
    clearTimers();
    wsRef.current?.close();
    wsRef.current = null;
    setIsConnected(false);
  }, [clearTimers]);

  const send = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    shouldConnectRef.current = true;
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return { isConnected, reconnectAttempt, send };
}
