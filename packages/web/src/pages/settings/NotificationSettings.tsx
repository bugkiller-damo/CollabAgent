import { useState } from "react";
import { toast } from "../../stores/toastStore";

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
    <div className="p-6 max-w-lg space-y-6">
      <h2 className="text-gray-900 dark:text-white text-xl font-bold">通知设置</h2>
      <p className="text-gray-500 text-sm">选择你希望接收的通知类型（偏好存储在本地浏览器）</p>

      <div className="space-y-3">
        {NOTIF_TYPES.map((n) => (
          <label key={n.key} className="flex items-center justify-between p-4 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700/50 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors">
            <div>
              <p className="text-gray-900 dark:text-white font-medium text-sm">{n.label}</p>
              <p className="text-gray-500 text-xs mt-0.5">{n.desc}</p>
            </div>
            <div
              onClick={() => toggle(n.key)}
              className={`relative w-10 h-5 rounded-full transition-colors ${prefs[n.key] ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${prefs[n.key] ? "translate-x-5" : "translate-x-0.5"}`} />
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
