import { useEffect } from "react";
import { useChannelStore } from "../../stores";

export function Sidebar() {
  const channels = useChannelStore((s) => s.channels);
  const activeChannelName = useChannelStore((s) => s.activeChannelName);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const unreadCounts = useChannelStore((s) => s.unreadCounts);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);

  useEffect(() => {
    fetchChannels().catch(() => {
      // Server not available — show empty state
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside className="w-60 bg-gray-800 border-r border-gray-700 flex flex-col shrink-0">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-white font-bold text-lg">CollabAgent</h1>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <div className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-2 py-1">
          频道
        </div>
        {channels.map((ch) => (
          <a
            key={ch.id}
            href={`/channels/${ch.name}`}
            onClick={(e) => {
              e.preventDefault();
              setActiveChannel(ch.name);
              window.history.pushState({}, "", `/channels/${ch.name}`);
            }}
            className={`flex items-center justify-between p-2 rounded text-sm
              ${ch.name === activeChannelName ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white hover:bg-gray-700"}`}
          >
            <span># {ch.name}</span>
            {(unreadCounts[ch.name] || 0) > 0 && (
              <span className="bg-blue-500 text-white text-xs rounded-full px-1.5 py-0.5">
                {unreadCounts[ch.name]}
              </span>
            )}
          </a>
        ))}
      </nav>
      <div className="p-3 border-t border-gray-700">
        <a href="/settings/profile" className="text-gray-400 hover:text-white text-sm">
          设置
        </a>
      </div>
    </aside>
  );
}
