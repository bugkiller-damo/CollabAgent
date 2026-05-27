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

  const { isConnected, reconnectAttempt } = useWebSocket({
    serverUrl: window.location.origin,
    token: token || "",
    onMessage: (msg: WsServerMessage) => {
      if (msg.type === "agent:deliver") {
        receiveMessage(msg.message);
        if (msg.message.channelId !== activeChannelName) {
          incrementUnread(msg.message.channelId);
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
