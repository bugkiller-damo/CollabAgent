import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Agent {
  id: string; name: string; display_name: string; description: string;
  status: string; runtime: string; model: string; isOnline: boolean;
}

export function AgentManagement() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState("claude");
  const [model, setModel] = useState("sonnet");

  const loadAgents = async () => {
    try {
      const data = await apiGet<{ agents: Agent[] }>("/api/agents");
      setAgents(data.agents || []);
    } catch {}
  };

  useEffect(() => { loadAgents(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      await apiPost("/api/agents", { name, displayName, description, runtime, model, serverId: "a319db9b-6f52-43e6-b6e2-563e75860636" });
      setShowCreate(false); setName(""); setDisplayName(""); setDescription("");
      loadAgents();
    } catch (err: any) { alert(err.message); }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-white text-xl font-bold">Agent 管理</h2>
        <button onClick={() => setShowCreate(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">
          + 创建 Agent
        </button>
      </div>

      {showCreate && (
        <div className="bg-gray-800 rounded-lg p-4 space-y-3">
          <h3 className="text-white font-semibold">创建新 Agent</h3>
          <input type="text" placeholder="Agent 名称 (如 slock-backend)" value={name}
            onChange={e => setName(e.target.value)}
            className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          <input type="text" placeholder="显示名称" value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          <input type="text" placeholder="描述" value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          <div className="flex gap-2">
            <select value={runtime} onChange={e => setRuntime(e.target.value)}
              className="p-2 rounded bg-gray-700 text-white border border-gray-600">
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="deepseek">DeepSeek</option>
            </select>
            <select value={model} onChange={e => setModel(e.target.value)}
              className="p-2 rounded bg-gray-700 text-white border border-gray-600">
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 text-sm">创建</button>
            <button onClick={() => setShowCreate(false)} className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-500 text-sm">取消</button>
          </div>
        </div>
      )}

      <div className="grid gap-3">
        {agents.map((a) => (
          <div key={a.id} className="bg-gray-800 rounded-lg p-4 flex items-center gap-4">
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center text-white font-bold text-sm">
                {a.name[0]?.toUpperCase() || "?"}
              </div>
              <div className={"absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-800 " + (a.isOnline ? "bg-green-500" : "bg-gray-500")} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-white font-semibold">@{a.name}</span>
                <span className={"text-xs px-1.5 py-0.5 rounded " + (a.isOnline ? "bg-green-900 text-green-300" : "bg-gray-700 text-gray-400")}>
                  {a.isOnline ? "在线" : "离线"}
                </span>
              </div>
              <p className="text-gray-400 text-sm truncate">{a.description || a.display_name}</p>
              <p className="text-gray-500 text-xs">{(a as any).runtime_profile?.runtime} / {(a as any).runtime_profile?.model}</p>
            </div>
          </div>
        ))}
        {agents.length === 0 && <p className="text-gray-500 text-center py-8">暂无 Agent</p>}
      </div>
    </div>
  );
}
