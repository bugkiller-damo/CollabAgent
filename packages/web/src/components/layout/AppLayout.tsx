import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useAuthStore, useMessageStore, useChannelStore } from "../../stores";
import type { WsServerMessage } from "@collabagent/shared";

export function AppLayout() {
  const { token } = useAuthStore();
  const receiveMessage = useMessageStore((s) => s.receiveMessage);
  const incrementUnread = useChannelStore((s) => s.incrementUnread);
  const activeChannelName = useChannelStore((s) => s.activeChannelName);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);

  useEffect(() => {
    fetchChannels().catch(() => {
      useChannelStore.setState({
        channels: [
          { id: "1", serverId: "s1", name: "general", visibility: "public" as const, archived: false, memberCount: 1, joined: true, createdAt: new Date().toISOString(), description: "主频道" },
          { id: "2", serverId: "s1", name: "random", visibility: "public" as const, archived: false, memberCount: 1, joined: true, createdAt: new Date().toISOString() },
        ],
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { isConnected, reconnectAttempt } = useWebSocket({
    serverUrl: window.location.origin,
    token: token || "",
    onMessage: (msg: WsServerMessage) => {
      if (msg.type === "agent:deliver" && msg.message) {
        const message = msg.message;
        receiveMessage(message);
        if (activeChannelName && message.id !== activeChannelName) {
          incrementUnread(message.id);
        }
      }
    },
  });

  return (
    <div className="flex h-screen bg-gray-900">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        {!isConnected && (
          <div className="bg-yellow-600 text-white text-center text-sm py-1">
            连接中断，重连中...（第 {reconnectAttempt} 次）
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
