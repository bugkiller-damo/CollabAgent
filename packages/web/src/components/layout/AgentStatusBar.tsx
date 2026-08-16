import { useEffect, useState } from "react";
import { apiGet } from "../../api/client";
import { useAgentStore, useUiStore } from "../../stores";
import { Avatar } from "../ui/Avatar";

interface Agent {
  id: string;
  name: string;
  display_name: string;
  isOnline: boolean;
  avatar_url?: string;
}

const LIVE_STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  working: { text: "工作中", cls: "text-blue-500" },
  starting: { text: "启动中", cls: "text-amber-500" },
  idle: { text: "空闲", cls: "text-green-500" },
  offline: { text: "离线", cls: "text-gray-400" },
  stopped: { text: "已停止", cls: "text-gray-400" },
};

export function AgentStatusBar() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const openTerminal = useUiStore((s) => s.openTerminal);
  const terminalAgent = useUiStore((s) => s.terminalAgent);
  const liveAgents = useAgentStore((s) => s.agents);

  useEffect(() => {
    apiGet<{ agents: Agent[] }>("/api/agents")
      .then((d) => {
        setAgents((d.agents || []).slice(0, 5));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

  return (
    <div className="border-t border-gray-200 p-2 dark:border-gray-700">
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Agent 状态
      </div>
      {agents.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-gray-400 dark:text-gray-500">暂无 Agent，去「接入 Agent」创建一个</div>
      ) : (
        agents.map((a) => {
          const live = liveAgents[a.name];
          const statusKey = live?.status && live.status !== "online" ? live.status : a.isOnline ? "idle" : "offline";
          const st = LIVE_STATUS_LABEL[statusKey] || LIVE_STATUS_LABEL.offline;
          return (
            <button
              key={a.id}
              onClick={() => openTerminal(terminalAgent === a.name ? null : a.name)}
              title="观察终端"
              className={[
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors",
                terminalAgent === a.name
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                  : "hover:bg-gray-200 dark:hover:bg-gray-700",
              ].join(" ")}
            >
              <div className={"h-2 w-2 shrink-0 rounded-full " + (a.isOnline ? "bg-green-500" : "bg-gray-500")} />
              <Avatar name={a.display_name || a.name} src={a.avatar_url} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate text-gray-600 dark:text-gray-300">@{a.name}</span>
                  <span className={`ml-auto shrink-0 text-[10px] ${st.cls}`}>{st.text}</span>
                </div>
                {/* last_pty_line：agent 终端的最后一行输出，实时看它正在干什么 */}
                {live?.detail && (
                  <p className="truncate text-[10px] text-gray-400 dark:text-gray-500" title={live.detail}>
                    {live.detail}
                  </p>
                )}
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}
