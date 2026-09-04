<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { LG_QUERY, useMediaQuery } from "../../composables";
import { dispatchWsEvent } from "../../lib/wsDispatch";
import { initWsManager, teardownWsManager, wsSend } from "../../lib/wsManager";
import {
  type SidebarPane,
  useChannelStore,
  useComputerStore,
  useMessageStore,
  useNotificationStore,
  useUiStore,
} from "../../stores";
import AgentTerminalPanel from "../agent/AgentTerminalPanel.vue";
import ErrorBoundary from "../ErrorBoundary.vue";
import OnboardingChecklist from "../OnboardingChecklist.vue";
import MemberProfileDrawer from "../people/MemberProfileDrawer.vue";
import ToastContainer from "../Toast.vue";
import IconButton from "../ui/IconButton.vue";
import MobileTabBar from "./MobileTabBar.vue";
import Sidebar from "./Sidebar.vue";

const route = useRoute();
const router = useRouter();
const messageStore = useMessageStore();
const channelStore = useChannelStore();
const notificationStore = useNotificationStore();
const uiStore = useUiStore();
const computerStore = useComputerStore();

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
  if (pathname === "/activity") return { title: "动态", subtitle: "" };
  if (pathname === "/people") return { title: "成员", subtitle: "" };
  if (pathname === "/search") return { title: "搜索", subtitle: "" };
  if (pathname.startsWith("/computers")) return { title: "计算机", subtitle: "" };
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
const isDesktop = useMediaQuery(LG_QUERY);
/** `/people` 桌面用右栏详情，不再叠全局抽屉；移动仍用全屏 sheet */
const showProfileDrawer = computed(() => !!uiStore.profileTarget && !(route.path === "/people" && isDesktop.value));

const isPrivateChannel = computed(
  () =>
    route.path.startsWith("/channels/") &&
    channelStore.channels.some(
      (c: any) => c.name === channelStore.activeChannelName && (c.type === "private" || c.visibility === "private"),
    ),
);

function paneForPath(pathname: string): SidebarPane | null {
  if (pathname.startsWith("/channels/") || pathname.startsWith("/dm/")) return "chat";
  if (pathname.startsWith("/tasks")) return "tasks";
  if (pathname === "/activity") return "activity";
  if (pathname === "/search") return "search";
  if (pathname === "/people" || pathname.startsWith("/admin/members")) {
    return "people";
  }
  if (pathname.startsWith("/computers")) return "computers";
  return null;
}

watch(
  () => route.path,
  (path, prev) => {
    const pane = paneForPath(path);
    if (pane) uiStore.setSidebarPane(pane);
    // /people 桌面档案写在 profileTarget 里，离页后仍会叠全局抽屉，需清掉
    if (prev?.startsWith("/people") && !path.startsWith("/people")) {
      uiStore.closeProfile();
    }
  },
  { immediate: true },
);

function goOnline() {
  uiStore.setOnline(true);
}
function goOffline() {
  uiStore.setOnline(false);
}

function onKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    uiStore.setSidebarPane("search");
    uiStore.closeMobileDrawer();
    void router.push("/search");
    return;
  }
  if (mod && e.key.toLowerCase() === "b") {
    e.preventDefault();
    uiStore.toggleSidebar();
  }
}

onMounted(() => {
  window.addEventListener("online", goOnline);
  window.addEventListener("offline", goOffline);
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  window.removeEventListener("online", goOnline);
  window.removeEventListener("offline", goOffline);
  window.removeEventListener("keydown", onKeydown);
});

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

onMounted(() => {
  void channelStore.fetchChannels();
  void notificationStore.loadFromApi();
  void computerStore.refresh();
});

// 必须 start：init 只创建句柄，不建连。漏调时聊天/观察全靠刷新 REST 才能看见。
const wsManager = initWsManager({
  url: window.location.origin.replace(/^http/, "ws") + "/ws",
  onEvent: dispatchWsEvent,
  onStatus: (status, attempt) => uiStore.setWsStatus(status, attempt),
  onConnect: (isReconnect) => {
    if (isReconnect) void messageStore.backfillAll();
    void messageStore.flushAllPending();
    // 面板若已开：首连竞态或重连后重订 watch（断线期间 unwatch 已清）
    const watching = uiStore.terminalAgent;
    if (watching) {
      wsSend({ type: "terminal:watch", agentName: watching });
      wsSend({ type: "terminal:history", agentName: watching });
    }
  },
});
onMounted(() => wsManager.start());
onUnmounted(() => teardownWsManager());

watch([() => uiStore.terminalAgent, () => channelStore.activeChannelName], ([name, chName]) => {
  if (!name || !chName) return;
  const ch = channelStore.channels.find((c) => c.name === chName);
  const members = ch?.id ? channelStore.membersByChannelId[ch.id] : undefined;
  if (!members) return;
  const ok = members.some((m) => m.member_type === "agent" && m.handle === name);
  if (!ok) uiStore.openTerminal(null);
});
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-canvas">
    <div
      v-if="uiStore.mobileDrawerOpen"
      class="fixed inset-0 z-30 bg-black/40 lg:hidden"
      @click="uiStore.closeMobileDrawer()"
    />

    <div
      :class="[
        'fixed lg:static inset-y-0 left-0 z-40 flex transform transition-transform duration-200 ease-in-out',
        uiStore.mobileDrawerOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      ]"
    >
      <Sidebar />
    </div>

    <main class="flex min-w-0 flex-1 flex-col pb-16 lg:pb-0">
      <header class="flex h-12 items-center gap-3 border-b border-gray-200 bg-white px-4 dark:border-gray-700 dark:bg-gray-800">
        <IconButton label="打开菜单" tooltip="菜单" class="lg:hidden" @click="uiStore.openMobileDrawer()">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </IconButton>

        <div class="min-w-0 flex-1 lg:hidden">
          <div v-if="routeTitle.title" class="flex flex-col">
            <span class="truncate text-sm font-semibold text-ink">{{ routeTitle.title }}</span>
            <span v-if="routeTitle.subtitle" class="truncate text-xs text-muted">{{ routeTitle.subtitle }}</span>
          </div>
        </div>

        <div class="hidden lg:flex lg:flex-1 lg:items-center lg:gap-2">
          <span v-if="routeTitle.subtitle" class="text-sm text-muted">{{ routeTitle.subtitle }}</span>
          <span v-if="routeTitle.subtitle && routeTitle.title" class="text-gray-300 dark:text-gray-600">/</span>
          <span class="text-sm font-semibold text-ink">{{ routeTitle.title }}</span>
          <svg
            v-if="isPrivateChannel"
            class="h-3.5 w-3.5 text-amber-500"
            fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
            aria-label="私有频道"
          >
            <title>私有频道</title>
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
        </div>
      </header>

      <div v-if="!uiStore.online" class="bg-amber-500 px-4 py-1.5 text-center text-sm text-white">
        ⚠️ 你当前处于离线状态，新消息可能无法收发
      </div>

      <ErrorBoundary>
        <div class="animate-fade-in flex min-h-0 flex-1 flex-col">
          <router-view />
        </div>
      </ErrorBoundary>
    </main>

    <MemberProfileDrawer v-if="showProfileDrawer" />

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
