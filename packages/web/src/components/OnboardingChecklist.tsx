import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";

const DISMISS_KEY = "onboarding_dismissed";

interface Step {
  label: string;
  done: boolean;
  to: string;
  cta: string;
}

// 首登轻量引导：检测真实状态（daemon 是否连上、是否有 Agent），给出下一步清单。
// 全部完成或用户手动关闭后不再出现（localStorage 记忆）。
export function OnboardingChecklist() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const [daemonOn, setDaemonOn] = useState<boolean | null>(null);
  const [hasAgent, setHasAgent] = useState<boolean | null>(null);

  useEffect(() => {
    if (dismissed) return;
    const load = () => {
      apiGet<{ connected: boolean }>("/api/daemon/status")
        .then((d) => setDaemonOn(!!d.connected))
        .catch(() => setDaemonOn(false));
      apiGet<{ agents: any[] }>("/api/agents")
        .then((d) => setHasAgent((d.agents || []).length > 0))
        .catch(() => setHasAgent(false));
    };
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [dismissed]);

  if (dismissed || daemonOn === null || hasAgent === null) return null;

  const steps: Step[] = [
    { label: "连接本机 Claude", done: daemonOn, to: "/connect", cta: "去连接" },
    { label: "创建第一个 Agent", done: hasAgent, to: "/connect", cta: "去创建" },
    { label: "邀请同事加入（可选）", done: false, to: "/admin/members", cta: "去邀请" },
  ];

  // 前两个必做步骤都完成则自动隐藏
  if (steps[0].done && steps[1].done) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };
  const next = steps.find((s) => !s.done) || steps[0];

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-gray-900 dark:text-white text-sm font-semibold">快速开始</h3>
        <button
          onClick={dismiss}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm"
          title="不再显示"
        >
          ✕
        </button>
      </div>
      <ul className="space-y-2">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-sm">
            <span className={s.done ? "text-green-500" : "text-gray-400"}>{s.done ? "✓" : "○"}</span>
            <span className={s.done ? "text-gray-400 line-through" : "text-gray-700 dark:text-gray-200"}>
              {s.label}
            </span>
          </li>
        ))}
      </ul>
      <Link
        to={next.to}
        className="mt-3 block text-center bg-blue-600 text-white text-sm py-2 rounded hover:bg-blue-500"
      >
        {next.cta}
      </Link>
    </div>
  );
}
