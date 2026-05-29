import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useAuthStore, useMessageStore, useChannelStore, useAgentStore, useUiStore } from "../../stores";
import type { WsServerMessage } from '@collabagent/shared';
import { ThinkingIndicator } from '../agent/ThinkingIndicator';

function AgentThinkingBanner() {
  const agents = useAgentStore((s) => s.agents);
  const thinking = Object.values(agents).find((a) => a.status === "thinking" || a.status === "working");
  if (!thinking) return null;
  return <ThinkingIndicator agentName={thinking.name} text={thinking.detail || "working..."} />;
}

export function AppLayout() {
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const theme = useUiStore((s) => s.theme);

  // Apply theme to <html>
  useEffect(() => {
    const root = document.documentElement;
    const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", isDark);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try { await fetchChannels(); } catch {}
    };
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { token } = useAuthStore();
  const receiveMessage = useMessageStore((s) => s.receiveMessage);
  const incrementUnread = useChannelStore((s) => s.incrementUnread);
  const activeChannelName = useChannelStore((s) => s.activeChannelName);

  const { isConnected, reconnectAttempt } = useWebSocket({
    serverUrl: window.location.origin,
    token: token || "",
    onMessage: (msg: WsServerMessage) => {
        // Agent activity routing
        if (msg.type === 'agent:status' || (msg.type as string) === 'agent:activity') {
          const a = msg as any;
          useAgentStore.getState().updateStatus(a.agentId || 'agent', msg.type === 'agent:status' ? (a.status || 'idle') : 'working', a.detail || '');
        }

      if (msg.type === "agent:deliver" && msg.message) {
        const m = msg.message as any;
        const hasThread = m.thread_id || m.threadId;
        // Resolve channelId to target string for store key
        const chs = useChannelStore.getState().channels;
        const ch = chs.find((c: any) => c.id === m.channelId);
        const targetKey = ch ? '#' + ch.name : m.channelId;
        receiveMessage({
          id: m.id,
          seq: m.seq,
          channelId: targetKey,
          senderId: m.senderId,
          senderName: m.senderName || "unknown",
          senderType: m.senderType || "human",
          content: m.content,
          time: m.time || new Date().toISOString(),
        });
        if (hasThread) {
          // Also store under thread key so ThreadView can pick it up
          const threadKey = targetKey + ':' + (m.thread_id || m.threadId || '').substring(0, 8);
          receiveMessage({ ...m, id: m.id, seq: m.seq, channelId: threadKey, senderId: m.senderId, senderName: m.senderName || 'unknown', senderType: m.senderType || 'human', content: m.content, time: m.time || new Date().toISOString() });
        }
        if (activeChannelName && ch?.name !== activeChannelName) {
          incrementUnread(targetKey);
        }
      }
    },
  });

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <AgentThinkingBanner />
        <Outlet />
      </main>
    </div>
  );
}
