import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useChannelStore } from "../../stores";

export function AppLayout() {
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

  // WebSocket disabled during initial dev — re-enable when WS server is ready
  const isConnected = true;
  const reconnectAttempt = 0;

  return (
    <div className="flex h-screen bg-gray-900">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
