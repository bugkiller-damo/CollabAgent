import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, apiClient } from "../../api/client";
import { AgentCardSkeleton } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { OrgMembersPanel } from "../../components/admin/OrgMembersPanel";
import { PageHeader } from "../../components/layout/PageHeader";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { Avatar } from "../../components/ui/Avatar";
import { useUiStore } from "../../stores";
import { toast } from "../../stores/toastStore";

interface Agent {
  id: string; name: string; display_name: string; description: string;
  status: string; runtime: string; model: string; isOnline: boolean; avatar_url?: string;
}

export function AgentManagement() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [runtime, setRuntime] = useState("claude");
  const [model, setModel] = useState("sonnet");
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  const openTerminal = useUiStore((s) => s.openTerminal);

  const loadAgents = async () => {
    try {
      const data = await apiGet<{ agents: Agent[] }>("/api/agents");
      setAgents(data.agents || []);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAgents();
    const t = setInterval(loadAgents, 5000);
    return () => clearInterval(t);
  }, []);

  const resetForm = () => {
    setShowForm(false);
    setEditId(null);
    setName("");
    setDisplayName("");
    setDescription("");
    setAvatarUrl("");
    setRuntime("claude");
    setModel("sonnet");
  };

  const openCreate = () => {
    setEditId(null);
    setName("");
    setDisplayName("");
    setDescription("");
    setAvatarUrl("");
    setRuntime("claude");
    setModel("sonnet");
    setShowForm(true);
  };

  const openEdit = (a: Agent) => {
    setEditId(a.id);
    setName(a.name);
    setDisplayName(a.display_name || "");
    setDescription(a.description || "");
    setAvatarUrl(a.avatar_url || "");
    setRuntime(a.runtime || "claude");
    setModel(a.model || "sonnet");
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    try {
      if (editId) {
        await apiPatch(`/api/agents/${editId}`, { name, displayName, description, avatarUrl, runtime, model });
      } else {
        await apiPost("/api/agents", { name, displayName, description, avatarUrl, runtime, model });
      }
      resetForm();
      loadAgents();
    } catch (err: any) {
      toast.error(err?.message || "保存失败");
    }
  };

  const handleDelete = async (a: Agent) => {
    setConfirmDelete(null);
    try {
      await apiClient(`/api/agents/${a.id}`, { method: "DELETE" });
      loadAgents();
    } catch (err: any) {
      toast.error(err?.message || "删除失败");
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader title="Agent 管理" backTo="/admin" breadcrumb={[{ label: "管理后台", to: "/admin" }, { label: "Agent 管理" }]} />

      <div className="flex items-center justify-end">
        <Button onClick={openCreate} size="sm">+ 创建 Agent</Button>
      </div>

      <OrgMembersPanel />

      {showForm && (
        <Card className="space-y-3">
          <h3 className="font-semibold text-gray-900 dark:text-white">{editId ? "编辑 Agent" : "创建新 Agent"}</h3>
          <Input type="text" placeholder="Agent 名称 (如 slock-backend)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input type="text" placeholder="显示名称" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <Input type="text" placeholder="描述（也作为它的角色设定）" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Input type="text" placeholder="头像 URL（可选）" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} />
          <div className="flex gap-2">
            <select
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              className="rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
              <option value="claude">Claude</option>
            </select>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSubmit} size="sm">{editId ? "保存" : "创建"}</Button>
            <Button onClick={resetForm} variant="secondary" size="sm">取消</Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {agents.map((a) => (
          <Card key={a.id} padding="md" className="flex items-center gap-4">
            <Avatar name={a.name} src={a.avatar_url} size="lg" online={a.isOnline} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900 dark:text-white">@{a.name}</span>
                {a.display_name && a.display_name !== a.name && <span className="text-sm text-gray-500">{a.display_name}</span>}
                <span className={[
                  "rounded px-1.5 py-0.5 text-xs",
                  a.isOnline
                    ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                    : "bg-gray-200 text-gray-500 dark:bg-gray-700",
                ].join(" ")}
                >
                  {a.isOnline ? "在线" : "离线"}
                </span>
              </div>
              <p className="truncate text-sm text-gray-500 dark:text-gray-400">{a.description || "（无描述）"}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{a.runtime} / {a.model}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => openTerminal(a.name)} variant="secondary" size="sm">终端</Button>
              <Button onClick={() => openEdit(a)} variant="secondary" size="sm">编辑</Button>
              <Button onClick={() => setConfirmDelete(a)} variant="ghost" size="sm" className="text-red-500 hover:text-red-600">删除</Button>
            </div>
          </Card>
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
