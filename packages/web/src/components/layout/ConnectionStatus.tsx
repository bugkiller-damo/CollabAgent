import { useUiStore } from "../../stores";

const CONFIG: Record<string, { dot: string; text: string; pulse?: boolean }> = {
  connected: { dot: "bg-green-500", text: "已连接" },
  connecting: { dot: "bg-yellow-500", text: "连接中…", pulse: true },
  reconnecting: { dot: "bg-yellow-500", text: "重连中…", pulse: true },
  disconnected: { dot: "bg-red-500", text: "已断开" },
};

export function ConnectionStatus() {
  const status = useUiStore((s) => s.wsStatus);
  const attempt = useUiStore((s) => s.wsReconnectAttempt);
  const online = useUiStore((s) => s.online);
  const cfg = CONFIG[status] || CONFIG.disconnected;

  // 连续重连多次仍失败 → 给出诊断提示
  const diagnostic = status !== "connected" && (attempt >= 2 || status === "disconnected")
    ? (!online ? "网络已断开，请检查本地网络" : "无法连接到服务器，请确认后端服务是否运行")
    : null;

  return (
    <div className="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400">
      <div className="flex items-center gap-2">
        <span className={"w-2 h-2 rounded-full shrink-0 " + cfg.dot + (cfg.pulse ? " animate-pulse" : "")} />
        <span className="truncate">
          {cfg.text}
          {status === "reconnecting" && attempt > 0 && <span className="text-gray-400">（第 {attempt} 次）</span>}
        </span>
      </div>
      {diagnostic && <div className="text-[11px] text-amber-500 mt-0.5 pl-4">{diagnostic}</div>}
    </div>
  );
}
