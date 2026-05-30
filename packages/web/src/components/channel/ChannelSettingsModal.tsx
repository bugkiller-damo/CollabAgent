import { useState } from "react";
import { useChannelStore } from "../../stores";
import { apiClient } from "../../api/client";
import { ConfirmDialog } from "../ConfirmDialog";

interface Props {
  channel: any;
  onClose: () => void;
  onArchived?: () => void;
  onDeleted?: () => void;
}

export function ChannelSettingsModal({ channel, onClose, onArchived, onDeleted }: Props) {
  const updateChannel = useChannelStore((s) => s.updateChannel);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const [description, setDescription] = useState(channel.description || "");
  const [visibility, setVisibility] = useState<"public" | "private">(channel.type === "private" ? "private" : "public");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "archive">(null);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await updateChannel(channel.id, { description: description.trim(), type: visibility });
      onClose();
    } catch (err: any) {
      setError(err?.message || "保存失败");
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setConfirm(null);
    setSaving(true);
    setError("");
    try {
      await apiClient(`/api/channels/${channel.id}`, { method: "DELETE" });
      await fetchChannels();
      onDeleted?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || "删除失败");
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    setConfirm(null);
    setSaving(true);
    setError("");
    try {
      await updateChannel(channel.id, { archived: true });
      onArchived?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || "归档失败");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4 space-y-4"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="text-gray-900 dark:text-white text-lg font-bold">频道设置 · #{channel.name}</h3>

        <div>
          <label className="text-gray-600 dark:text-gray-400 text-sm block mb-1">描述</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="这个频道用来做什么？"
            className="w-full p-2 rounded bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
        </div>

        <div>
          <label className="text-gray-600 dark:text-gray-400 text-sm block mb-1">可见性</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setVisibility("public")}
              className={"flex-1 p-2 rounded text-sm border " +
                (visibility === "public"
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600")}>
              # 公开
            </button>
            <button type="button" onClick={() => setVisibility("private")}
              className={"flex-1 p-2 rounded text-sm border " +
                (visibility === "private"
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600")}>
              🔒 私有
            </button>
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-3">
            <button type="button" onClick={() => setConfirm("archive")} disabled={saving}
              className="text-sm text-amber-500 hover:text-amber-400 disabled:opacity-50">
              归档
            </button>
            <button type="button" onClick={() => setConfirm("delete")} disabled={saving}
              className="text-sm text-red-500 hover:text-red-400 disabled:opacity-50">
              删除频道
            </button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600">
              取消
            </button>
            <button type="button" onClick={handleSave} disabled={saving}
              className="px-4 py-2 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>

      {confirm === "delete" && (
        <ConfirmDialog
          title={`删除频道 #${channel.name}`}
          message="此操作不可撤销，频道内所有消息都会被永久删除。"
          confirmLabel="删除"
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "archive" && (
        <ConfirmDialog
          title={`归档频道 #${channel.name}`}
          message="归档后将不可发送消息，但仍可查看历史。"
          confirmLabel="归档"
          onConfirm={handleArchive}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
