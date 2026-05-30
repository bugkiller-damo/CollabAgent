import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, apiClient } from "../../api/client";
import { AgentCardSkeleton } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { OrgMembersPanel } from "../../components/admin/OrgMembersPanel";

interface Agent {
  id: string; name: string; display_name: string; description: string;
  status: string; runtime: string; model: string; isOnline: boolean;
}

export function AgentManagement() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState("claude");
  const [model, setModel] = useState("sonnet");
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);

  const loadAgents = async () => {
    try {
      const data = await apiGet<{ agents: Agent[] }>("/api/agents");
      setAgents(data.agents || []); setLoading(false);
    } catch { setLoading(false); }
  };

  useEffect(() => { loadAgents(); }, []);

  const resetForm = () => {
    setShowForm(false); setEditId(null);
    setName(""); setDisplayName(""); setDescription("");
    setRuntime("claude"); setModel("sonnet");
  };

  const openCreate = () => {
    setEditId(null); setName(""); setDisplayName(""); setDescription("");
    setRuntime("claude"); setModel("sonnet"); setShowForm(true);
  };

  const openEdit = (a: Agent) => {
    setEditId(a.id); setName(a.name); setDisplayName(a.display_name || "");
    setDescription(a.description || ""); setRuntime(a.runtime || "claude");
    setModel(a.model || "sonnet"); setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    try {
      if (editId) {
        await apiPatch(`/api/agents/${editId}`, { name, displayName, description, runtime, model });
      } else {
        // 不传 serverId → 落到你的私有空间（仅你可见，直到把别人加进协作组织）
        await apiPost("/api/agents", { name, displayName, description, runtime, model });
      }
      resetForm();
      loadAgents();
    } catch (err: any) { alert(err?.message || "保存失败"); }
  };

  const handleDelete = async (a: Agent) => {
    setConfirmDelete(null);
    try {
      await apiClient(`/api/agents/${a.id}`, { method: "DELETE" });
      loadAgents();
    } catch (err: any) { alert(err?.message || "删除失败"); }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-gray-900 dark:text-white text-xl font-bold">Agent 管理</h2>
        <button onClick={openCreate}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">
          + 创建 Agent
        </button>
      </div>

      <OrgMembersPanel />

      {showForm && (
        <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 space-y-3">
          <h3 className="text-gray-900 dark:text-white font-semibold">{editId ? "编辑 Agent" : "创建新 Agent"}</h3>
          <input type="text" placeholder="Agent 名称 (如 slock-backend)" value={name}
            onChange={e => setName(e.target.value)}
            className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
          <input type="text" placeholder="显示名称" value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
          <input type="text" placeholder="描述（也作为它的角色设定）" value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
          <div className="flex gap-2">
            <select value={runtime} onChange={e => setRuntime(e.target.value)}
              className="p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600">
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="deepseek">DeepSeek</option>
            </select>
            <select value={model} onChange={e => setModel(e.target.value)}
              className="p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600">
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSubmit} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 text-sm">{editId ? "保存" : "创建"}</button>
            <button onClick={resetForm} className="bg-gray-300 dark:bg-gray-600 text-gray-800 dark:text-white px-4 py-2 rounded hover:bg-gray-400 dark:hover:bg-gray-500 text-sm">取消</button>
          </div>
        </div>
      )}

      <div className="grid gap-3">
        {agents.map((a) => (
          <div key={a.id} className="group bg-gray-100 dark:bg-gray-800 rounded-lg p-4 flex items-center gap-4">
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-gray-500 dark:bg-gray-600 flex items-center justify-center text-white font-bold text-sm">
                {a.name[0]?.toUpperCase() || "?"}
              </div>
              <div className={"absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-100 dark:border-gray-800 " + (a.isOnline ? "bg-green-500" : "bg-gray-400")} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-gray-900 dark:text-white font-semibold">@{a.name}</span>
                {a.display_name && a.display_name !== a.name && <span className="text-gray-500 text-sm">{a.display_name}</span>}
                <span className={"text-xs px-1.5 py-0.5 rounded " + (a.isOnline ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300" : "bg-gray-200 dark:bg-gray-700 text-gray-500")}>
                  {a.isOnline ? "在线" : "离线"}
                </span>
              </div>
              <p className="text-gray-500 dark:text-gray-400 text-sm truncate">{a.description || "（无描述）"}</p>
              <p className="text-gray-400 dark:text-gray-500 text-xs">{a.runtime} / {a.model}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => openEdit(a)}
                className="text-sm px-3 py-1.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600">编辑</button>
              <button onClick={() => setConfirmDelete(a)}
                className="text-sm px-3 py-1.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30">删除</button>
            </div>
          </div>
        ))}
        {loading && <AgentCardSkeleton />}
        {!loading && agents.length === 0 && (
          <EmptyState icon="🤖" title="还没有 Agent" description="创建一个 AI Agent，让它加入频道协作"
            actionLabel="+ 创建 Agent" onAction={openCreate} />
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`删除 Agent @${confirmDelete.name}`}
          message="将移除该 Agent 及其频道成员关系（历史消息保留）。此操作不可撤销。"
          confirmLabel="删除"
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
