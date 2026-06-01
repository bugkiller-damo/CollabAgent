import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost, apiPatch, apiClient } from "../../api/client";
import { ConfirmDialog } from "../../components/ConfirmDialog";

interface Channel {
  id: string; name: string; description: string | null;
  type: string; archived: boolean; role?: string | null;
}

// 频道管理：创建、归档/取消归档、删除。后端 /api/channels 已具备完整 CRUD。
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
      .then((d) => { setChannels(d.channels || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setMsg("");
    try {
      await apiPost("/api/channels", { name: n, description: description.trim(), visibility });
      setName(""); setDescription(""); setVisibility("public"); setShowForm(false);
      load();
    } catch (e: any) { setMsg(e?.message || "创建失败"); }
  };

  const toggleArchive = async (c: Channel) => {
    try { await apiPatch(`/api/channels/${c.id}`, { archived: !c.archived }); load(); }
    catch (e: any) { setMsg(e?.message || "操作失败"); }
  };

  const doDelete = async (c: Channel) => {
    try { await apiClient(`/api/channels/${c.id}`, { method: "DELETE" }); setConfirmDelete(null); load(); }
    catch (e: any) { setMsg(e?.message || "删除失败"); setConfirmDelete(null); }
  };

  const inputCls = "w-full p-2 rounded text-sm bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600";

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-gray-900 dark:text-white text-xl font-bold">频道管理</h2>
        <button onClick={() => setShowForm((v) => !v)} className="bg-blue-600 text-white px-3 py-2 rounded text-sm hover:bg-blue-500">
          {showForm ? "取消" : "+ 新建频道"}
        </button>
      </div>
      {msg && <p className="text-red-400 text-sm">{msg}</p>}

      {showForm && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-3">
          <input className={inputCls} placeholder="频道名称（如 product）" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          <input className={inputCls} placeholder="描述（可选）" value={description}
            onChange={(e) => setDescription(e.target.value)} />
          <select className={inputCls} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="public">公开（所有成员可见）</option>
            <option value="private">私有（仅受邀成员）</option>
          </select>
          <button onClick={create} disabled={!name.trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-500 disabled:opacity-50">创建</button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">加载中…</p>
      ) : (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
          {channels.map((c) => (
            <div key={c.id} className="flex items-center gap-3 p-3">
              <span className="text-gray-400">{c.type === "private" ? "🔒" : "#"}</span>
              <div className="flex-1 min-w-0">
                <p className="text-gray-900 dark:text-white text-sm truncate">
                  {c.name}{c.archived && <span className="ml-2 text-xs text-gray-400">（已归档）</span>}
                </p>
                {c.description && <p className="text-gray-500 text-xs truncate">{c.description}</p>}
              </div>
              <button onClick={() => toggleArchive(c)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                {c.archived ? "取消归档" : "归档"}
              </button>
              <button onClick={() => setConfirmDelete(c)} className="text-xs text-gray-400 hover:text-red-500">删除</button>
            </div>
          ))}
          {channels.length === 0 && <p className="text-gray-500 text-sm p-4">暂无频道</p>}
        </div>
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
