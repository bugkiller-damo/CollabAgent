import { useState } from "react";
import { useChannelStore } from "../../stores";
import { Modal } from "../ui/Modal";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";

// 频道名格式化：小写、空格转连字符、移除非法字符、合并多个连字符
export function formatChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9一-龥-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface Props {
  onClose: () => void;
  onCreated?: (name: string) => void;
}

export function CreateChannelModal({ onClose, onCreated }: Props) {
  const createChannel = useChannelStore((s) => s.createChannel);
  const channels = useChannelStore((s) => s.channels);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const formatted = formatChannelName(name);
  const exists = channels.some((c) => c.name === formatted);
  const canSubmit = formatted.length > 0 && !exists && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError("");
    try {
      await createChannel({ name: formatted, description: description.trim() || undefined, type: visibility });
      onCreated?.(formatted);
      onClose();
    } catch (err: any) {
      setError(err?.message || "创建失败");
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose}>
      <h3 className="text-lg font-bold text-gray-900 dark:text-white">创建频道</h3>

      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-gray-600 dark:text-gray-400">频道名称</label>
          <Input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            placeholder="例如 产品讨论 / product"
          />
          {formatted && (
            <p className="mt-1 text-xs text-gray-500">
              频道标识：<span className="text-blue-500"># {formatted}</span>
              {exists && <span className="ml-2 text-red-400">该频道已存在</span>}
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600 dark:text-gray-400">描述（可选）</label>
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

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} variant="secondary" size="sm">取消</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} loading={saving} size="sm">{saving ? "创建中…" : "创建"}</Button>
        </div>
      </div>
    </Modal>
  );
}
