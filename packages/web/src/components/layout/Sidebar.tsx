import { useNavigate } from "react-router-dom";
import { useChannelStore, useAuthStore } from "../../stores";

export function Sidebar() {
  const channels = useChannelStore((s) => s.channels);
  const activeChannelName = useChannelStore((s) => s.activeChannelName);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const unreadCounts = useChannelStore((s) => s.unreadCounts);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  return (
    <aside className="w-60 bg-gray-800 border-r border-gray-700 flex flex-col shrink-0">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-white font-bold text-lg">CollabAgent</h1>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <div className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-2 py-1">
          频道
        </div>
        {channels.map((ch: any) => (
          <button
            key={ch.id}
            onClick={() => {
              setActiveChannel(ch.name);
              navigate(`/channels/${ch.name}`);
            }}
            className={`w-full text-left flex items-center justify-between p-2 rounded text-sm
              ${ch.name === activeChannelName ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white hover:bg-gray-700"}`}
          >
            <span># {ch.name}</span>
            {(unreadCounts[ch.name] || 0) > 0 && (
              <span className="bg-blue-500 text-white text-xs rounded-full px-1.5 py-0.5">
                {unreadCounts[ch.name]}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="p-3 border-t border-gray-700 space-y-1">
        {user && (
          <div className="text-gray-400 text-xs px-1 mb-1">
            已登录：{user.handle}
          </div>
        )}
        <button onClick={() => navigate("/settings/profile")} className="block w-full text-left text-gray-400 hover:text-white text-sm">
          设置
        </button>
        <button onClick={() => { logout(); navigate("/login"); }} className="block w-full text-left text-gray-400 hover:text-red-400 text-sm">
          退出登录
        </button>
      </div>
    </aside>
  );
}
