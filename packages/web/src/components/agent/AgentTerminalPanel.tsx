import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../../api/client";
import { useTerminalStore } from "../../stores/terminalStore";
import { wsSend } from "../../stores/wsSender";

interface AgentOption {
  name: string;
  display_name?: string;
  isOnline: boolean;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  working: { text: "工作中", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  starting: { text: "启动中", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  idle: { text: "空闲", cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  offline: { text: "未运行", cls: "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400" },
  stopped: { text: "已停止", cls: "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400" },
};

interface AgentTerminalPanelProps {
  agentName: string;
  onSelectAgent: (name: string) => void;
  onClose: () => void;
}

const MIN_W = 300;
const MAX_W = 1000;
const MIN_FS = 10;
const MAX_FS = 20;

/**
 * Agent 终端右侧常驻面板（G3）：可以挂在频道页旁边边聊边看。
 * - 左侧边缘拖拽调宽（localStorage 记忆）；字号 A-/A+ 可调。
 * - 「实时」页：daemon 每 0.4s 推来的当前屏（打开面板即 watch，关闭即 unwatch）。
 * - 「日志」页：落盘的终端历史（agent 被回收后也可回看），可手动刷新。
 */
export function AgentTerminalPanel({ agentName, onSelectAgent, onClose }: AgentTerminalPanelProps) {
  const frame = useTerminalStore((s) => s.frames[agentName]);
  const history = useTerminalStore((s) => s.histories[agentName]);
  const [tab, setTab] = useState<"live" | "log">("live");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const livePreRef = useRef<HTMLPreElement>(null);
  const logPreRef = useRef<HTMLPreElement>(null);

  // 面板宽度（可拖拽，localStorage 记忆）
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("terminal_panel_w"));
    return saved >= MIN_W && saved <= MAX_W ? saved : 420;
  });
  // 终端字号（localStorage 记忆）
  const [fontSize, setFontSize] = useState(() => {
    const saved = Number(localStorage.getItem("terminal_panel_fs"));
    return saved >= MIN_FS && saved <= MAX_FS ? saved : 12;
  });

  // 拖拽调宽：按住面板左边缘拖动
  const dragState = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startW: width };
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        // 面板在屏幕右缘：鼠标越往左拖，面板越宽
        const next = dragState.current.startW + (dragState.current.startX - ev.clientX);
        setWidth(Math.min(MAX_W, Math.max(MIN_W, Math.round(next))));
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setWidth((w) => {
          localStorage.setItem("terminal_panel_w", String(w));
          return w;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width],
  );

  const changeFontSize = (delta: number) => {
    setFontSize((fs) => {
      const next = Math.min(MAX_FS, Math.max(MIN_FS, fs + delta));
      localStorage.setItem("terminal_panel_fs", String(next));
      return next;
    });
  };

  // 观看/取消观看 + 拉一次历史日志（打开或切换 agent 时）
  useEffect(() => {
    wsSend({ type: "terminal:watch", agentName });
    wsSend({ type: "terminal:history", agentName });
    return () => wsSend({ type: "terminal:unwatch", agentName });
  }, [agentName]);

  // 尺寸协商（真改比例）：面板宽度/字号变化时，按可视区算出期望的 cols/rows
  // 发给 daemon 实时 resize PTY（Claude Code 收 SIGWINCH 重排画面）。防抖 300ms，
  // 拖拽结束时只发最终值，不会在拖动过程中刷一串 resize。
  useEffect(() => {
    const el = livePreRef.current;
    if (!el) return;
    const t = setTimeout(() => {
      const charW = fontSize * 0.6; // 等宽字体近似字宽
      const lineH = fontSize * 1.5; // 与 pre 的 lineHeight 对齐
      const cols = Math.max(20, Math.floor((el.clientWidth - 24) / charW));
      const rows = Math.max(5, Math.floor((el.clientHeight - 24) / lineH));
      wsSend({ type: "terminal:resize", agentName, cols, rows });
    }, 300);
    return () => clearTimeout(t);
  }, [width, fontSize, agentName]);

  // 面板顶部的 agent 选择器数据
  useEffect(() => {
    apiGet<{ agents: AgentOption[] }>("/api/agents")
      .then((d) => setAgents(d.agents || []))
      .catch(() => {});
  }, []);

  // 新帧/新日志到达时滚到底部
  useEffect(() => {
    const el = tab === "live" ? livePreRef.current : logPreRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frame?.screen, history, tab]);

  const status = frame?.status || "offline";
  const st = STATUS_LABEL[status] || STATUS_LABEL.offline;

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
    >
      {/* 拖拽调宽把手（左边缘） */}
      <div
        onMouseDown={onDragStart}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-blue-400/40 active:bg-blue-500/50"
        title="拖拽调整宽度"
      />

      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <select
          value={agentName}
          onChange={(e) => onSelectAgent(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-100 px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          {!agents.some((a) => a.name === agentName) && <option value={agentName}>@{agentName}</option>}
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.isOnline ? "🟢" : "⚪"} @{a.name}
              {a.display_name && a.display_name !== a.name ? `（${a.display_name}）` : ""}
            </option>
          ))}
        </select>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${st.cls}`}>{st.text}</span>
        <button
          onClick={onClose}
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          aria-label="关闭终端面板"
        >
          ✕
        </button>
      </div>

      <div className="flex items-center border-b border-gray-200 text-sm dark:border-gray-700">
        <button
          onClick={() => setTab("live")}
          className={`flex-1 py-1.5 ${tab === "live" ? "border-b-2 border-blue-500 font-medium text-gray-900 dark:text-white" : "text-gray-500"}`}
        >
          实时画面
        </button>
        <button
          onClick={() => setTab("log")}
          className={`flex-1 py-1.5 ${tab === "log" ? "border-b-2 border-blue-500 font-medium text-gray-900 dark:text-white" : "text-gray-500"}`}
        >
          历史日志
        </button>
        {/* 字号调节 */}
        <div className="flex shrink-0 items-center gap-0.5 px-2">
          <button
            onClick={() => changeFontSize(-1)}
            className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            title="缩小字号"
          >
            A-
          </button>
          <span className="w-6 text-center text-[11px] text-gray-400">{fontSize}</span>
          <button
            onClick={() => changeFontSize(1)}
            className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            title="放大字号"
          >
            A+
          </button>
        </div>
      </div>

      {tab === "live" ? (
        <pre
          ref={livePreRef}
          style={{ fontSize, lineHeight: 1.5 }}
          className="flex-1 overflow-auto bg-gray-950 p-3 font-mono text-green-200 whitespace-pre"
        >
          {frame?.screen || "等待终端画面…（agent 未运行时无输出）"}
        </pre>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <pre
            ref={logPreRef}
            style={{ fontSize, lineHeight: 1.5 }}
            className="flex-1 overflow-auto bg-gray-950 p-3 font-mono text-gray-300 whitespace-pre-wrap"
          >
            {history?.trim() || "暂无历史日志（agent 运行过并结束后会落盘保留）"}
          </pre>
          <button
            onClick={() => wsSend({ type: "terminal:history", agentName })}
            className="border-t border-gray-200 py-1.5 text-xs text-blue-500 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700"
          >
            刷新日志
          </button>
        </div>
      )}

      <p className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-400 dark:border-gray-700">
        {tab === "live"
          ? `画面每 0.4s 刷新，仅在观看时传输${frame?.time ? " · 最近更新 " + new Date(frame.time).toLocaleTimeString("zh-CN") : ""}`
          : "日志在 agent 每次运行结束时落盘，含本次 run 的完整画面"}
      </p>
    </aside>
  );
}
