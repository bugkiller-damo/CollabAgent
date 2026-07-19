import { useState } from "react";
import { toast } from "../../stores/toastStore";
import { PageHeader } from "../../components/layout/PageHeader";

/** 通知偏好（按类型设置接收渠道） */
const NOTIF_TYPES = [
  { key: "@mention", label: "@提及", desc: "有人在消息中提及你" },
  { key: "dm", label: "私信", desc: "收到新的私信" },
  { key: "task_assigned", label: "任务指派", desc: "有人给你指派了任务" },
  { key: "reminder", label: "提醒", desc: "Agent 或系统提醒到期" },
  { key: "system", label: "系统通知", desc: "频道变更、成员变动等" },
] as const;

type NotifPrefs = Record<string, boolean>;

function loadPrefs(): NotifPrefs {
  try {
    return JSON.parse(localStorage.getItem("notif_prefs") || "{}");
  } catch { return {}; }
}
function savePrefs(prefs: NotifPrefs) {
  localStorage.setItem("notif_prefs", JSON.stringify(prefs));
}

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotifPrefs>(() => {
    const saved = loadPrefs();
    return Object.fromEntries(NOTIF_TYPES.map((n) => [n.key, saved[n.key] ?? true]));
  });

  const toggle = (key: string) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      savePrefs(next);
      toast.success(`通知已${next[key] ? "开启" : "关闭"}`);
      return next;
    });
  };

  return (
    <div className="w-full space-y-6">
      <PageHeader title="通知" backTo="/settings" />
      <p className="text-sm text-gray-500">选择你希望接收的通知类型（偏好存储在本地浏览器）</p>

      <div className="grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2">
        {NOTIF_TYPES.map((n) => (
          <label
            key={n.key}
            className="flex cursor-pointer items-center justify-between rounded-lg border border-gray-100 bg-gray-50 p-4 transition-colors hover:bg-gray-100 dark:border-gray-700/50 dark:bg-gray-800 dark:hover:bg-gray-700/50"
          >
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{n.label}</p>
              <p className="mt-0.5 text-xs text-gray-500">{n.desc}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={prefs[n.key]}
              onClick={() => toggle(n.key)}
              className={`relative h-5 w-10 rounded-full transition-colors ${prefs[n.key] ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"}`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  prefs[n.key] ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        ))}
      </div>
    </div>
  );
}
