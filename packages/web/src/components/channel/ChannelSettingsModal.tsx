import { useState } from "react";
import { apiClient } from "../../api/client";
import { useChannelStore } from "../../stores";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";

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
    <>
      <Modal open onClose={onClose}>
        <h3 className="text-lg font-bold text-gray-900 dark:text-white">频道设置 · #{channel.name}</h3>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-gray-600 dark:text-gray-400">描述</label>
            <Input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这个频道用来做什么？"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-gray-600 dark:text-gray-400">可见性</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setVisibility("public")}
                className={[
                  "flex-1 rounded-md border p-2 text-sm transition-colors",
                  visibility === "public"
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300",
                ].join(" ")}
              >
                # 公开
              </button>
              <button
                type="button"
                onClick={() => setVisibility("private")}
                className={[
                  "flex-1 rounded-md border p-2 text-sm transition-colors",
                  visibility === "private"
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300",
                ].join(" ")}
              >
                🔒 私有
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex items-center justify-between pt-2">
            <div className="flex gap-3">
              <Button
                onClick={() => setConfirm("archive")}
                disabled={saving}
                variant="ghost"
                size="sm"
                className="text-amber-500 hover:text-amber-400"
              >
                归档
              </Button>
              <Button
                onClick={() => setConfirm("delete")}
                disabled={saving}
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-400"
              >
                删除频道
              </Button>
            </div>
            <div className="flex gap-2">
              <Button onClick={onClose} variant="secondary" size="sm">
                取消
              </Button>
              <Button onClick={handleSave} disabled={saving} loading={saving} size="sm">
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

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
    </>
  );
}
