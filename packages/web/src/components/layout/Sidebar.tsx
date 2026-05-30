import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useChannelStore, useAuthStore, useUiStore } from "../../stores";
import { apiGet } from "../../api/client";
import { AgentStatusBar } from "./AgentStatusBar";
import { ConnectionStatus } from "./ConnectionStatus";
import { CreateChannelModal } from "../channel/CreateChannelModal";

interface DmItem { channelId: string; peerHandle: string; peerName: string; peerType: "human" | "agent"; lastContent?: string }
interface PeopleItem { handle: string; displayName: string; type: "human" | "agent" }

export function Sidebar() {
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const channels = useChannelStore((s) => s.channels);
  const activeChannelName = useChannelStore((s) => s.activeChannelName);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const unreadCounts = useChannelStore((s) => s.unreadCounts);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => location.pathname.startsWith(path);

  // 私信会话列表 + 发起新私信
  const [dms, setDms] = useState<DmItem[]>([]);
  const [showPeople, setShowPeople] = useState(false);
  const [people, setPeople] = useState<PeopleItem[]>([]);
  const loadDms = () => { apiGet<{ dms: DmItem[] }>("/api/channels/dms").then((d) => setDms(d.dms || [])).catch(() => {}); };
  useEffect(() => { loadDms(); }, [location.pathname]);
  const openPeoplePicker = async () => {
    setShowPeople((v) => !v);
    if (people.length === 0) {
      const list: PeopleItem[] = [];
      try {
        const a = await apiGet<{ agents: any[] }>("/api/agents");
        for (const x of a.agents || []) list.push({ handle: x.name, displayName: x.display_name || x.name, type: "agent" });
      } catch {}
      try {
        const s = await apiGet<any>("/api/server/info");
        for (const h of s.humans || []) {
          if (h.handle === user?.handle) continue;
          list.push({ handle: h.handle, displayName: h.display_name || h.handle, type: "human" });
        }
      } catch {}
      setPeople(list);
    }
  };
  const startDm = (handle: string) => { setShowPeople(false); navigate("/dm/" + handle); };
  const activeDmHandle = location.pathname.startsWith("/dm/") ? decodeURIComponent(location.pathname.split("/")[2] || "") : "";

  return (
    <aside className="w-60 bg-gray-100 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col shrink-0">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-gray-900 dark:text-white font-bold text-lg">CollabAgent</h1>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">频道</span>
          <button onClick={() => setShowCreateChannel(true)} title="创建频道"
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-base leading-none px-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700">
            +
          </button>
        </div>
        {channels.map((ch: any) => (
          <button
            key={ch.id}
            onClick={() => { setActiveChannel(ch.name); navigate("/channels/" + ch.name); }}
            className={"w-full text-left flex items-center justify-between p-2 rounded text-sm " +
              (ch.name === activeChannelName ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white hover:bg-gray-200 dark:bg-gray-700")}
          >
            <span># {ch.name}</span>
            {(unreadCounts[ch.name] || 0) > 0 && (
              <span className="bg-blue-500 text-gray-900 dark:text-white text-xs rounded-full px-1.5 py-0.5">
                {unreadCounts[ch.name]}
              </span>
            )}
          </button>
        ))}

        <div className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-2 py-1 mt-4">
          功能
        </div>
        <button onClick={() => navigate("/tasks")}
          className={"w-full text-left p-2 rounded text-sm " +
            (isActive("/tasks") ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white hover:bg-gray-200 dark:bg-gray-700")}>
          📋 任务看板
        </button>

        <div className="flex items-center justify-between px-2 py-1 mt-4 relative">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">私信</span>
          <button onClick={openPeoplePicker} title="发起私信"
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-base leading-none px-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700">
            +
          </button>
          {showPeople && (
            <div className="absolute right-0 top-7 z-30 w-52 max-h-72 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1">
              {people.length === 0 && <div className="px-3 py-2 text-gray-400 text-xs">没有可私信的对象</div>}
              {people.map((p) => (
                <button key={p.type + ":" + p.handle} onClick={() => startDm(p.handle)}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                  <span>{p.type === "agent" ? "🤖" : "👤"}</span>
                  <span className="truncate">{p.displayName}</span>
                  <span className="text-gray-400 text-xs ml-auto">@{p.handle}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {dms.map((d) => (
          <button key={d.channelId} onClick={() => navigate("/dm/" + d.peerHandle)}
            className={"w-full text-left flex items-center gap-2 p-2 rounded text-sm " +
              (d.peerHandle === activeDmHandle ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white hover:bg-gray-200 dark:bg-gray-700")}>
            <span>{d.peerType === "agent" ? "🤖" : "👤"}</span>
            <span className="truncate">{d.peerName || d.peerHandle}</span>
          </button>
        ))}
        {dms.length === 0 && (
          <p className="px-2 py-1 text-gray-400 text-xs">点 + 发起私信</p>
        )}
      </nav>
      <AgentStatusBar />
      <div className="border-t border-gray-200 dark:border-gray-700">
        <ConnectionStatus />
      </div>
      <div className="p-3 border-t border-gray-200 dark:border-gray-700 space-y-1">
        {user && (
          <div className="text-gray-600 dark:text-gray-400 text-xs px-1 mb-1">已登录：{user.handle}</div>
        )}
        <button onClick={() => navigate("/admin/agents")}
          className={"block w-full text-left text-sm p-1 rounded " +
            (isActive("/admin/agents") ? "text-gray-900 dark:text-white bg-gray-200 dark:bg-gray-700" : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white")}>
          🤖 Agent 管理
        </button>
        <button onClick={() => (theme === "dark" ? setTheme("light") : setTheme("dark"))}
        className="block w-full text-left text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white text-sm mb-1">
        {theme === "dark" ? "☀️ 浅色模式" : "🌙 深色模式"}
      </button>
      <button onClick={() => navigate("/settings/profile")}
          className={"block w-full text-left text-sm p-1 rounded " +
            (isActive("/settings/profile") ? "text-gray-900 dark:text-white bg-gray-200 dark:bg-gray-700" : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white")}>
          ⚙️ 设置
        </button>
        <button onClick={() => { logout(); navigate("/login"); }}
          className="block w-full text-left text-gray-600 dark:text-gray-400 hover:text-red-400 text-sm p-1 rounded">
          退出登录
        </button>
      </div>
      {showCreateChannel && (
        <CreateChannelModal
          onClose={() => setShowCreateChannel(false)}
          onCreated={(name) => { setActiveChannel(name); navigate("/channels/" + name); }}
        />
      )}
    </aside>
  );
}
