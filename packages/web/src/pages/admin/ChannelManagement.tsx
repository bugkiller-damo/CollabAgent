import { useCallback, useEffect, useState } from "react";
import { apiClient, apiGet, apiPatch, apiPost } from "../../api/client";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PageHeader } from "../../components/layout/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";

interface Channel {
  id: string;
  name: string;
  description: string | null;
  type: string;
  archived: boolean;
  role?: string | null;
}

export function ChannelManagement() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [msg, setMsg] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Channel | null>(null);

  const load = useCallback(() => {
    apiGet<{ channels: Channel[] }>("/api/channels")
      .then((d) => {
        setChannels(d.channels || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setMsg("");
    try {
      await apiPost("/api/channels", { name: n, description: description.trim(), visibility });
      setName("");
      setDescription("");
      setVisibility("public");
      setShowForm(false);
      load();
    } catch (e: any) {
      setMsg(e?.message || "创建失败");
    }
  };

  const toggleArchive = async (c: Channel) => {
    try {
      await apiPatch(`/api/channels/${c.id}`, { archived: !c.archived });
      load();
    } catch (e: any) {
      setMsg(e?.message || "操作失败");
    }
  };

  const doDelete = async (c: Channel) => {
    try {
      await apiClient(`/api/channels/${c.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      load();
    } catch (e: any) {
      setMsg(e?.message || "删除失败");
      setConfirmDelete(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 p-4 sm:p-6">
      <PageHeader
        title="频道管理"
        backTo="/admin"
        breadcrumb={[{ label: "管理后台", to: "/admin" }, { label: "频道管理" }]}
      />

      <div className="flex items-center justify-end">
        <Button onClick={() => setShowForm((v) => !v)} size="sm">
          {showForm ? "取消" : "+ 新建频道"}
        </Button>
      </div>

      {msg && <p className="text-sm text-red-500">{msg}</p>}

      {showForm && (
        <Card className="space-y-3">
          <Input
            placeholder="频道名称（如 product）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <Input placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            <option value="public">公开（所有成员可见）</option>
            <option value="private">私有（仅受邀成员）</option>
          </select>
          <Button onClick={create} disabled={!name.trim()} size="sm">
            创建
          </Button>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">加载中…</p>
      ) : (
        <Card padding="none" className="divide-y divide-gray-200 dark:divide-gray-700">
          {channels.map((c) => (
            <div key={c.id} className="flex items-center gap-3 p-3">
              <span className="text-gray-400">{c.type === "private" ? "🔒" : "#"}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                  {c.name}
                  {c.archived && <span className="ml-2 text-xs text-gray-400">（已归档）</span>}
                </p>
                {c.description && <p className="truncate text-xs text-gray-500">{c.description}</p>}
              </div>
              <Button onClick={() => toggleArchive(c)} variant="ghost" size="sm">
                {c.archived ? "取消归档" : "归档"}
              </Button>
              <Button
                onClick={() => setConfirmDelete(c)}
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-600"
              >
                删除
              </Button>
            </div>
          ))}
          {channels.length === 0 && <p className="p-4 text-sm text-gray-500">暂无频道</p>}
        </Card>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`删除频道 #${confirmDelete.name}？`}
          message="频道内的消息将一并删除，且无法恢复。"
          confirmLabel="删除"
          danger
          onConfirm={() => doDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
