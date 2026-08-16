import type { WsServerMessage } from "@collabagent/shared";
import { memo, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useAgentStore, useAuthStore, useChannelStore, useMessageStore, useUiStore } from "../../stores";
import { useNotificationStore } from "../../stores/notificationStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { toast } from "../../stores/toastStore";
import { setWsSender } from "../../stores/wsSender";
import { AgentTerminalPanel } from "../agent/AgentTerminalPanel";
import { ThinkingIndicator } from "../agent/ThinkingIndicator";
import { SearchBar } from "../chat/SearchBar";
import { ErrorBoundary } from "../ErrorBoundary";
import { NotificationBell } from "../notifications/NotificationBell";
import { OnboardingChecklist } from "../OnboardingChecklist";
import { ToastContainer } from "../Toast";
import { IconButton } from "../ui/IconButton";
import { MobileTabBar } from "./MobileTabBar";
import { Sidebar } from "./Sidebar";

function AgentThinkingBanner() {
  const agents = useAgentStore((s) => s.agents);
  const thinking = Object.values(agents).find((a) => a.status === "thinking" || a.status === "working");
  if (!thinking) return null;
  return <ThinkingIndicator agentName={thinking.name} text={thinking.detail || "working..."} />;
}

function useRouteTitle(pathname: string) {
  const decode = (s: string | undefined) => {
    try {
      return decodeURIComponent(s || "");
    } catch {
      return s || "";
    }
  };
  if (pathname.startsWith("/channels/")) {
    const parts = pathname.split("/");
    const channel = decode(parts[2]);
    const thread = parts[3];
    if (thread) return { title: "线程", subtitle: `#${channel}` };
    return { title: `#${channel}`, subtitle: "频道" };
  }
  if (pathname.startsWith("/dm/")) {
    const peer = decode(pathname.split("/")[2]);
    const thread = pathname.split("/")[3];
    if (thread) return { title: "线程", subtitle: `@${peer}` };
    return { title: `@${peer}`, subtitle: "私信" };
  }
  if (pathname.startsWith("/tasks")) {
    const ch = pathname.split("/")[2];
    if (ch) return { title: "任务看板", subtitle: `#${decode(ch)}` };
    return { title: "任务看板", subtitle: "" };
  }
  if (pathname === "/connect") return { title: "接入 Agent", subtitle: "" };
  if (pathname.startsWith("/admin/agents")) return { title: "Agent 管理", subtitle: "管理后台" };
  if (pathname.startsWith("/admin/channels")) return { title: "频道管理", subtitle: "管理后台" };
  if (pathname.startsWith("/admin/members")) return { title: "成员管理", subtitle: "管理后台" };
  if (pathname.startsWith("/admin/metrics")) return { title: "运行指标", subtitle: "管理后台" };
  if (pathname === "/admin") return { title: "管理后台", subtitle: "" };
  if (pathname.startsWith("/settings/profile")) return { title: "个人资料", subtitle: "设置" };
  if (pathname.startsWith("/settings/security")) return { title: "安全与账户", subtitle: "设置" };
  if (pathname.startsWith("/settings/integrations")) return { title: "集成", subtitle: "设置" };
  if (pathname.startsWith("/settings/notifications")) return { title: "通知", subtitle: "设置" };
  if (pathname === "/settings") return { title: "设置", subtitle: "" };
  return { title: "", subtitle: "" };
}

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const theme = useUiStore((s) => s.theme);
  const online = useUiStore((s) => s.online);
  const setOnline = useUiStore((s) => s.setOnline);
  const location = useLocation();
  const routeTitle = useRouteTitle(location.pathname);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [setOnline]);

  useEffect(() => {
    const root = document.documentElement;
    const isDark =
      theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", isDark);
  }, [theme]);

  useEffect(() => {
    const load = async () => {
      try {
        await fetchChannels();
      } catch {}
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { isAuthenticated } = useAuthStore();
  const receiveMessage = useMessageStore((s) => s.receiveMessage);
  const incrementUnread = useChannelStore((s) => s.incrementUnread);
  const activeChannelName = useChannelStore((s) => s.activeChannelName);
  const setWsStatus = useUiStore((s) => s.setWsStatus);
  // 顶部标题栏的私有频道标识：从频道列表里查当前频道类型
  // （server 返回的字段名是 type，shared 类型里叫 visibility，两个都兼容）
  const channels = useChannelStore((s) => s.channels);
  const isPrivateChannel =
    location.pathname.startsWith("/channels/") &&
    channels.some((c: any) => c.name === activeChannelName && (c.type === "private" || c.visibility === "private"));
  // 终端观察面板（G3）：右侧常驻，边聊边看
  const terminalAgent = useUiStore((s) => s.terminalAgent);
  const openTerminal = useUiStore((s) => s.openTerminal);

  const { isConnected, reconnectAttempt, send } = useWebSocket({
    serverUrl: window.location.origin,
    token: "",
    onMessage: (msg: WsServerMessage) => {
      if ((msg.type as string) === "notification.new") {
        useNotificationStore.getState().prependNotification((msg as any).notification);
      }
      // 终端观察（G3）：daemon 推来的终端帧写入 terminalStore
      if ((msg.type as string) === "terminal:frame") {
        const f = msg as any;
        useTerminalStore
          .getState()
          .setFrame(f.agentName, { screen: f.screen || "", status: f.status || "unknown", time: f.time });
      }
      if (msg.type === "agent:status" || (msg.type as string) === "agent:activity") {
        const a = msg as any;
        // daemon 上报带 agentName（G7 last_pty_line）；旧消息只有 agentId，兜底
        useAgentStore
          .getState()
          .updateStatus(
            a.agentName || a.agentId || "agent",
            msg.type === "agent:status" ? a.status || "idle" : "working",
            a.detail || "",
          );
      }
      // 门控投递反馈：daemon 把发给忙碌 agent 的消息排队了（agent 空闲后按序投递，不丢）
      if ((msg.type as string) === "agent:delivery-queued") {
        const q = msg as any;
        toast.info(`⏳ @${q.agentName} 正在工作，消息已缓冲，将在其空闲后自动投递`);
      }
      if ((msg.type as string) === "message:update" && (msg as any).message) {
        const u = (msg as any).message;
        useMessageStore.getState().applyMessageUpdate(u.id, u.content, u.editedAt);
      }
      if ((msg.type as string) === "message:delete" && (msg as any).message) {
        useMessageStore.getState().applyMessageDelete((msg as any).message.id);
      }
      if (msg.type === "agent:deliver" && msg.message) {
        const m = msg.message as any;
        const hasThread = m.thread_id || m.threadId;
        const chs = useChannelStore.getState().channels;
        const ch = chs.find((c: any) => c.id === m.channelId);
        const targetKey = ch ? "#" + ch.name : m.channelId;
        receiveMessage({
          id: m.id,
          seq: m.seq,
          channelId: targetKey,
          senderId: m.senderId,
          senderName: m.senderName || "unknown",
          senderType: m.senderType || "human",
          content: m.content,
          time: m.time || new Date().toISOString(),
          attachments: m.attachments || [],
        } as any);
        if (hasThread) {
          const threadKey = targetKey + ":" + (m.thread_id || m.threadId || "").substring(0, 8);
          receiveMessage({
            ...m,
            id: m.id,
            seq: m.seq,
            channelId: threadKey,
            senderId: m.senderId,
            senderName: m.senderName || "unknown",
            senderType: m.senderType || "human",
            content: m.content,
            time: m.time || new Date().toISOString(),
          });
        }
        if (activeChannelName && ch?.name !== activeChannelName) {
          incrementUnread(targetKey);
        }
      }
    },
  });

  useEffect(() => {
    if (isConnected) setWsStatus("connected", 0);
    else if (reconnectAttempt > 0) setWsStatus("reconnecting", reconnectAttempt);
    else setWsStatus("connecting", 0);
  }, [isConnected, reconnectAttempt, setWsStatus]);

  // 注入全局 WS 发送器（终端观察 watch/unwatch 等浏览器→server 消息用）
  useEffect(() => {
    setWsSender(send as unknown as (msg: Record<string, unknown>) => void);
    return () => setWsSender(null);
  }, [send]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      <div
        className={`fixed lg:static inset-y-0 left-0 z-40 w-60 transform transition-transform duration-200 ease-in-out ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
      >
        <Sidebar />
      </div>

      <main className="flex min-w-0 flex-1 flex-col pb-16 lg:pb-0">
        <header className="flex h-12 items-center gap-3 border-b border-gray-200 bg-white px-4 dark:border-gray-700 dark:bg-gray-800">
          <IconButton label="打开菜单" tooltip="菜单" onClick={() => setSidebarOpen(true)} className="lg:hidden">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </IconButton>

          <div className="min-w-0 flex-1 lg:hidden">
            {routeTitle.title && (
              <div className="flex flex-col">
                <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{routeTitle.title}</span>
                {routeTitle.subtitle && (
                  <span className="truncate text-xs text-gray-500 dark:text-gray-400">{routeTitle.subtitle}</span>
                )}
              </div>
            )}
          </div>

          <div className="hidden lg:flex lg:flex-1 lg:items-center lg:gap-2">
            {routeTitle.subtitle && (
              <span className="text-sm text-gray-500 dark:text-gray-400">{routeTitle.subtitle}</span>
            )}
            {routeTitle.subtitle && routeTitle.title && <span className="text-gray-300 dark:text-gray-600">/</span>}
            <span className="text-sm font-semibold text-gray-900 dark:text-white">{routeTitle.title}</span>
            {isPrivateChannel && (
              <svg
                className="h-3.5 w-3.5 text-amber-500"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
                aria-label="私有频道"
              >
                <title>私有频道</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                />
              </svg>
            )}
          </div>

          <div className="flex items-center gap-2">
            <SearchBar />
            <NotificationBell />
            <Link to="/settings/profile" className="hidden sm:block">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                {useAuthStore.getState().user?.handle?.[0]?.toUpperCase() || "?"}
              </div>
            </Link>
          </div>
        </header>

        {!online && (
          <div className="bg-amber-500 px-4 py-1.5 text-center text-sm text-white">
            ⚠️ 你当前处于离线状态，新消息可能无法收发
          </div>
        )}
        <AgentThinkingBanner />
        <ErrorBoundary>
          <div key={location.key} className="animate-fade-in flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </ErrorBoundary>
      </main>

      {/* 终端观察面板（G3）：右侧常驻，桌面端显示 */}
      {terminalAgent && (
        <div className="hidden lg:flex">
          <AgentTerminalPanel
            agentName={terminalAgent}
            onSelectAgent={(n) => openTerminal(n)}
            onClose={() => openTerminal(null)}
          />
        </div>
      )}

      <OnboardingChecklist />
      <ToastContainer />
      <MobileTabBar />
    </div>
  );
}
