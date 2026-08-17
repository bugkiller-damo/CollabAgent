<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useWebSocket } from "../../composables";
import { useAgentStore, useAuthStore, useChannelStore, useMessageStore, useUiStore } from "../../stores";
import type { AgentActivity } from "../../stores/agentStore";
import { useNotificationStore } from "../../stores/notificationStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { toast } from "../../stores/toastStore";
import { setWsSender } from "../../stores/wsSender";
import type { AgentStatusEvent, WsServerEvent } from "../../types";
import AgentTerminalPanel from "../agent/AgentTerminalPanel.vue";
import ErrorBoundary from "../ErrorBoundary.vue";
import NotificationBell from "../notifications/NotificationBell.vue";
import OnboardingChecklist from "../OnboardingChecklist.vue";
import ToastContainer from "../Toast.vue";
import IconButton from "../ui/IconButton.vue";
import MobileTabBar from "./MobileTabBar.vue";
import Sidebar from "./Sidebar.vue";

const route = useRoute();
const authStore = useAuthStore();
const messageStore = useMessageStore();
const channelStore = useChannelStore();
const agentStore = useAgentStore();
const uiStore = useUiStore();
const notificationStore = useNotificationStore();
const terminalStore = useTerminalStore();

const sidebarOpen = ref(false);

function decode(s: string | undefined): string {
  try {
    return decodeURIComponent(s || "");
  } catch {
    return s || "";
  }
}

function useRouteTitle(pathname: string): { title: string; subtitle: string } {
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

const routeTitle = computed(() => useRouteTitle(route.path));

// 顶部标题栏的私有频道标识：从频道列表里查当前频道类型
// （server 返回的字段名是 type，shared 类型里叫 visibility，两个都兼容）
const isPrivateChannel = computed(
  () =>
    route.path.startsWith("/channels/") &&
    channelStore.channels.some(
      (c: any) => c.name === channelStore.activeChannelName && (c.type === "private" || c.visibility === "private"),
    ),
);

function goOnline() {
  uiStore.setOnline(true);
}
function goOffline() {
  uiStore.setOnline(false);
}
onMounted(() => {
  window.addEventListener("online", goOnline);
  window.addEventListener("offline", goOffline);
});
onUnmounted(() => {
  window.removeEventListener("online", goOnline);
  window.removeEventListener("offline", goOffline);
});

// 暗色同步到 <html>（React 版用 useEffect([theme])，这里用 watch immediate）
watch(
  () => uiStore.theme,
  (theme) => {
    const root = document.documentElement;
    const isDark =
      theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", isDark);
  },
  { immediate: true },
);

// 初始拉取频道列表
onMounted(() => {
  const load = async () => {
    try {
      await channelStore.fetchChannels();
    } catch {}
  };
  load();
});

// ---- WS 建立 + onMessage switch 分发（React 版在 AppLayout.tsx:112-179） ----
const onMessage = (msg: WsServerEvent) => {
  if (msg.type === "notification.new") {
    notificationStore.prependNotification(msg.notification);
  }
  // 终端观察（G3）：daemon 推来的终端帧写入 terminalStore
  if (msg.type === "terminal:frame") {
    terminalStore.setFrame(msg.agentName, {
      screen: msg.screen || "",
      status: msg.status || "unknown",
      time: msg.time,
    });
  }
  if (msg.type === "agent:status" || msg.type === "agent:activity") {
    const a = msg as unknown as AgentStatusEvent;
    // daemon 上报带 agentName（G7 last_pty_line）；旧消息只有 agentId，兜底
    const id = a.agentName || a.agentId || "agent";
    const status = msg.type === "agent:status" ? a.status || "idle" : "working";
    agentStore.updateStatus(id, status as AgentActivity, a.detail || "");
  }
  // 门控投递反馈：daemon 把发给忙碌 agent 的消息排队了（agent 空闲后按序投递，不丢）
  if (msg.type === "agent:delivery-queued") {
    toast.info(`⏳ @${msg.agentName} 正在工作，消息已缓冲，将在其空闲后自动投递`);
  }
  if (msg.type === "message:update" && msg.message) {
    messageStore.applyMessageUpdate(msg.message.id, msg.message.content, msg.message.editedAt);
  }
  if (msg.type === "message:delete" && msg.message) {
    messageStore.applyMessageDelete(msg.message.id);
  }
  if (msg.type === "agent:deliver" && msg.message) {
    const m = msg.message as any;
    // 乐观行调和：回执带上发送时的 clientNonce，先清掉本地对应的 pending 乐观行
    if (m.clientNonce) messageStore.ackPendingByNonce(m.clientNonce);
    const hasThread = m.thread_id || m.threadId;
    const chs = channelStore.channels;
    const ch = chs.find((c: any) => c.id === m.channelId);
    const targetKey = ch ? "#" + ch.name : m.channelId;
    messageStore.receiveMessage({
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
      messageStore.receiveMessage({
        ...m,
        id: m.id,
        seq: m.seq,
        channelId: threadKey,
        senderId: m.senderId,
        senderName: m.senderName || "unknown",
        senderType: m.senderType || "human",
        content: m.content,
        time: m.time || new Date().toISOString(),
      } as any);
    }
    if (channelStore.activeChannelName && ch?.name !== channelStore.activeChannelName) {
      channelStore.incrementUnread(targetKey);
    }
  }
};

// 断线标记：本会话发生过断连后，下一次 onConnect 才需要增量补拉（首连靠 fetchHistory）
let hadDisconnect = false;

const { isConnected, reconnectAttempt, send } = useWebSocket({
  serverUrl: window.location.origin,
  token: "",
  onMessage,
  onConnect: () => {
    // 非首次连接 → 按 lastSeenSeq 增量补拉断线窗口（失败静默，不阻断连接）
    if (hadDisconnect) void messageStore.backfillAll();
    // 每次连接都补发离线队列：上会话恢复出的 queued 需要在首连时立即补发
    void messageStore.flushAllPending();
  },
  onDisconnect: () => {
    hadDisconnect = true;
  },
});

// wsStatus 同步 uiStore
watch(
  [isConnected, reconnectAttempt],
  ([connected, attempt]) => {
    if (connected) uiStore.setWsStatus("connected", 0);
    else if (attempt > 0) uiStore.setWsStatus("reconnecting", attempt);
    else uiStore.setWsStatus("connecting", 0);
  },
  { immediate: true },
);

// 注入全局 WS 发送器（终端观察 watch/unwatch 等浏览器→server 消息用），卸载时清理
onMounted(() => {
  setWsSender(send as unknown as (msg: Record<string, unknown>) => void);
});
onUnmounted(() => {
  setWsSender(null);
});
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-30 bg-black/40 lg:hidden"
      @click="sidebarOpen = false"
    />

    <div
      :class="[
        'fixed lg:static inset-y-0 left-0 z-40 w-60 transform transition-transform duration-200 ease-in-out',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      ]"
    >
      <Sidebar />
    </div>

    <main class="flex min-w-0 flex-1 flex-col pb-16 lg:pb-0">
      <header class="flex h-12 items-center gap-3 border-b border-gray-200 bg-white px-4 dark:border-gray-700 dark:bg-gray-800">
        <IconButton label="打开菜单" tooltip="菜单" class="lg:hidden" @click="sidebarOpen = true">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </IconButton>

        <div class="min-w-0 flex-1 lg:hidden">
          <div v-if="routeTitle.title" class="flex flex-col">
            <span class="truncate text-sm font-semibold text-gray-900 dark:text-white">{{ routeTitle.title }}</span>
            <span v-if="routeTitle.subtitle" class="truncate text-xs text-gray-500 dark:text-gray-400">{{ routeTitle.subtitle }}</span>
          </div>
        </div>

        <div class="hidden lg:flex lg:flex-1 lg:items-center lg:gap-2">
          <span v-if="routeTitle.subtitle" class="text-sm text-gray-500 dark:text-gray-400">{{ routeTitle.subtitle }}</span>
          <span v-if="routeTitle.subtitle && routeTitle.title" class="text-gray-300 dark:text-gray-600">/</span>
          <span class="text-sm font-semibold text-gray-900 dark:text-white">{{ routeTitle.title }}</span>
          <svg
            v-if="isPrivateChannel"
            class="h-3.5 w-3.5 text-amber-500"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
            aria-label="私有频道"
          >
            <title>私有频道</title>
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
        </div>

        <div class="flex items-center gap-2">
          <!-- SearchBar 尚未迁移（chat/ 目录后续批次），此处暂缺 -->
          <NotificationBell />
          <RouterLink to="/settings/profile" class="hidden sm:block">
            <div class="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
              {{ authStore.user?.handle?.[0]?.toUpperCase() || "?" }}
            </div>
          </RouterLink>
        </div>
      </header>

      <div v-if="!uiStore.online" class="bg-amber-500 px-4 py-1.5 text-center text-sm text-white">
        ⚠️ 你当前处于离线状态，新消息可能无法收发
      </div>

      <!-- AgentThinkingBanner 尚未迁移（依赖 agent/ThinkingIndicator），此处暂缺 -->

      <ErrorBoundary>
        <div class="animate-fade-in flex min-h-0 flex-1 flex-col">
          <router-view />
        </div>
      </ErrorBoundary>
    </main>

    <!-- 终端观察面板（G3）：uiStore.terminalAgent 非空即开（ChannelView 观察终端按钮等触发） -->
    <AgentTerminalPanel
      v-if="uiStore.terminalAgent"
      :agent-name="uiStore.terminalAgent"
      :on-select-agent="(name: string) => uiStore.openTerminal(name)"
      :on-close="() => uiStore.openTerminal(null)"
    />

    <OnboardingChecklist />
    <ToastContainer />
    <MobileTabBar />
  </div>
</template>
