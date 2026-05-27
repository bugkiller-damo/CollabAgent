import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useAuthStore, useMessageStore, useChannelStore } from "../../stores";
import type { WsServerMessage } from "@collabagent/shared";

export function AppLayout() {
  const fetchChannels = useChannelStore((s) => s.fetchChannels);

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
      if (msg.type === "agent:deliver" && msg.message) {
        const m = msg.message as any;
        receiveMessage({
          id: m.id,
          seq: m.seq,
          channelId: m.channelId,
          senderId: m.senderId,
          senderName: m.senderName || "unknown",
          senderType: m.senderType || "human",
          content: m.content,
          time: m.time || new Date().toISOString(),
        });
        if (activeChannelName && m.channelId !== activeChannelName) {
          incrementUnread(m.channelId);
        }
      }
    },
  });

  return (
    <div className="flex h-screen bg-gray-900">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
