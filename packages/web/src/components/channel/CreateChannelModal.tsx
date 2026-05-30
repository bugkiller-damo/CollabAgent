import { useState } from "react";
import { useChannelStore } from "../../stores";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4 space-y-4"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="text-gray-900 dark:text-white text-lg font-bold">创建频道</h3>

        <div>
          <label className="text-gray-600 dark:text-gray-400 text-sm block mb-1">频道名称</label>
          <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            placeholder="例如 产品讨论 / product"
            className="w-full p-2 rounded bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
          {formatted && (
            <p className="text-xs mt-1 text-gray-500">
              频道标识：<span className="text-blue-500"># {formatted}</span>
              {exists && <span className="text-red-400 ml-2">该频道已存在</span>}
            </p>
          )}
        </div>

        <div>
          <label className="text-gray-600 dark:text-gray-400 text-sm block mb-1">描述（可选）</label>
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

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600">
            取消
          </button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit}
            className="px-4 py-2 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
            {saving ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
