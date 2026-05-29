import { useEffect, useState } from "react";
import { apiGet } from "../../api/client";

interface Agent {
  id: string; name: string; display_name: string; isOnline: boolean;
}

export function AgentStatusBar() {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    apiGet<{ agents: Agent[] }>("/api/agents").then(d => {
      setAgents((d.agents || []).slice(0, 5));
    }).catch(() => {});
  }, []);

  if (agents.length === 0) return null;

  return (
    <div className="p-2 border-t border-gray-700">
      <div className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-2 py-1">
        Agent 状态
      </div>
      {agents.map(a => (
        <div key={a.id} className="flex items-center gap-2 px-2 py-1 text-sm">
          <div className={"w-2 h-2 rounded-full " + (a.isOnline ? "bg-green-500" : "bg-gray-500")} />
          <span className="text-gray-400 truncate">@{a.name}</span>
        </div>
      ))}
    </div>
  );
}
