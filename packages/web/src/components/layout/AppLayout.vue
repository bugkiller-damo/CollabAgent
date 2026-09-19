<script setup lang="ts">
import { Lock, Menu, TriangleAlert, X } from "@lucide/vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { LG_QUERY, useMediaQuery } from "../../composables";
import { channelPath, parseChannelRoute, parseTasksRoute, tasksPath, threadPath } from "../../lib/nav";
import { dispatchWsEvent } from "../../lib/wsDispatch";
import { initWsManager, teardownWsManager, wsSend } from "../../lib/wsManager";
import {
  hasOwnServer,
  type SidebarPane,
  useAuthStore,
  useChannelStore,
  useComputerStore,
  useMessageStore,
  useNotificationStore,
  useServerStore,
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
const serverStore = useServerStore();
const authStore = useAuthStore();

function decode(s: string | undefined): string {
  try {
    return decodeURIComponent(s || "");
  } catch {
    return s || "";
  }
}

function useRouteTitle(pathname: string): { title: string; subtitle: string } {
  // guild 化：新旧频道路径统一解析；副标题带 server 名提示语境
  const cr = parseChannelRoute(pathname);
  if (cr) {
    const serverName = serverStore.orgs.find((o) => o.id === cr.serverId)?.name;
    const scope = serverName ? `${serverName} · ` : "";
    if (cr.threadId) return { title: "线程", subtitle: `${scope}#${cr.channelName}` };
    return { title: `#${cr.channelName}`, subtitle: `${scope}频道` };
  }
  if (pathname.startsWith("/dm/")) {
    const peer = decode(pathname.split("/")[2]);
    const thread = pathname.split("/")[3];
    if (thread) return { title: "线程", subtitle: `@${peer}` };
    return { title: `@${peer}`, subtitle: "私信" };
  }
  const tr = parseTasksRoute(pathname);
  if (tr) {
    if (tr.channelName) return { title: "任务看板", subtitle: `#${tr.channelName}` };
    return { title: "任务看板", subtitle: "" };
  }
  if (pathname === "/activity") return { title: "动态", subtitle: "" };
  if (pathname === "/people") return { title: "成员", subtitle: "" };
  if (pathname === "/search") return { title: "搜索", subtitle: "" };
  if (pathname.startsWith("/computers")) return { title: "计算机", subtitle: "" };
  if (pathname.startsWith("/settings/profile")) return { title: "个人资料", subtitle: "设置" };
  if (pathname.startsWith("/settings/security")) return { title: "安全与账户", subtitle: "设置" };
  if (pathname.startsWith("/settings/integrations")) return { title: "集成", subtitle: "设置" };
  if (pathname.startsWith("/settings/notifications")) return { title: "通知", subtitle: "设置" };
  if (pathname.startsWith("/settings/metrics")) return { title: "运行指标", subtitle: "设置" };
  if (pathname === "/settings") return { title: "设置", subtitle: "" };
  return { title: "", subtitle: "" };
}

const routeTitle = computed(() => useRouteTitle(route.path));
const isDesktop = useMediaQuery(LG_QUERY);
/** `/people` 桌面用右栏详情，不再叠全局抽屉；移动仍用全屏 sheet */
const showProfileDrawer = computed(() => !!uiStore.profileTarget && !(route.path === "/people" && isDesktop.value));

const isPrivateChannel = computed(
  () =>
    !!parseChannelRoute(route.path) &&
    channelStore.channels.some(
      (c: any) => c.name === channelStore.activeChannelName && (c.type === "private" || c.visibility === "private"),
    ),
);

function paneForPath(pathname: string): SidebarPane | null {
  if (parseChannelRoute(pathname) || pathname.startsWith("/dm/")) return "chat";
  if (parseTasksRoute(pathname)) return "tasks";
  if (pathname === "/activity") return "activity";
  if (pathname === "/search") return "search";
  if (pathname === "/people") {
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

// ---- guild 化：server 语境同步 ----
// 1) URL serverId → activeServerId：/s/:serverId/* 路由把 server 语境显式化；
//    非成员 server id（手改 URL/被移出后旧链）回落到合法 active
watch(
  [() => route.params.serverId, () => serverStore.orgs],
  ([sid]) => {
    if (typeof sid !== "string" || !sid || !serverStore.loaded) return;
    if (serverStore.orgs.some((o) => o.id === sid)) {
      if (sid !== serverStore.activeServerId) serverStore.setActive(sid);
    } else if (serverStore.activeServerId) {
      // 回落到活跃 server 的合法落点：按真实频道列表解析——新建 server
      // 没有 general（只有私有 onboarding-owner），硬编码会 404。解析是
      // async，落地前复核 URL 上的 serverId 仍是那个非法值再替换。
      const bad = sid;
      const target = serverStore.activeServerId;
      void channelStore.resolveLandingChannel(target).then((name) => {
        if (String(route.params.serverId || "") === bad) void router.replace(channelPath(target, name));
      });
    }
  },
  { immediate: true },
);

// 2) activeServerId → channelStore：切 server 立即清旧列表再拉新 server 频道
watch(
  () => serverStore.activeServerId,
  (sid) => {
    channelStore.resetForServer(sid);
    if (sid) void channelStore.fetchChannels(sid);
  },
  { immediate: true },
);

// 3) 旧 URL 规范化：/channels/:name 与 /tasks[/:name] → /s/<active>/...
//    activeServerId 未就绪时等其就绪（orgs 加载或恢复 localStorage 后再 replace）
watch(
  [() => route.path, () => serverStore.activeServerId],
  ([path, sid]) => {
    if (!sid) return;
    const cr = parseChannelRoute(path);
    if (cr && !cr.serverId) {
      const doReplace = (name: string) =>
        void router.replace({
          path: cr.threadId ? threadPath(sid, name, cr.threadId) : channelPath(sid, name),
          query: route.query,
          hash: route.hash,
        });
      // 新建 server 没有 general（只有私有 onboarding-owner）——/、
      // /channels、/admin/channels、登录与 404 页的落点统一是
      // /channels/general，先经 resolveLandingChannel 校验：存在则原样
      // 规范化，不存在落到记忆/首频道。其余旧频道名（含 dm:<uuid> 伪频道
      // 名）维持直通。
      if (cr.channelName === "general") {
        void channelStore.resolveLandingChannel(sid, cr.channelName).then((name) => {
          const now = parseChannelRoute(route.path);
          if (now && !now.serverId && now.channelName === cr.channelName) doReplace(name);
        });
      } else {
        doReplace(cr.channelName);
      }
      return;
    }
    const tr = parseTasksRoute(path);
    if (tr && !tr.serverId) {
      void router.replace({ path: tasksPath(sid, tr.channelName), query: route.query });
    }
  },
  { immediate: true },
);

// D1：受邀/存量用户没有自有 server 时的持久引导条（每会话可暂关）
// hasOwnServer 而非 ownedCount：广场 owner（实例 admin）天然 owner，单看
// role 会把无自有 server 的用户误判为「已有」（serverStore.hasOwnServer 注释详述）
const HINT_DISMISS_KEY = "slock.hideCreateServerHint";
const hintDismissed = ref(typeof sessionStorage !== "undefined" && sessionStorage.getItem(HINT_DISMISS_KEY) === "1");
const showCreateServerHint = computed(
  () => serverStore.loaded && !hasOwnServer(serverStore.orgs) && !hintDismissed.value,
);
function dismissCreateServerHint() {
  hintDismissed.value = true;
  try {
    sessionStorage.setItem(HINT_DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

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
  // orgs 拉取后 activeServerId 校验/回落由 serverStore.fetchOrgs 完成；
  // 频道列表由上方 activeServerId watcher 拉取（resetForServer + fetchChannels）
  void serverStore.fetchOrgs();
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
          <Menu class="h-5 w-5" />
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
          <span v-if="isPrivateChannel" class="text-amber-500" aria-label="私有频道">
            <Lock class="h-3.5 w-3.5" />
          </span>
        </div>
      </header>

      <div v-if="!uiStore.online" class="bg-amber-500 px-4 py-1.5 text-center text-sm text-gray-900">
        <TriangleAlert class="mr-1 inline h-4 w-4" aria-hidden="true" /> 你当前处于离线状态，新消息可能无法收发
      </div>

      <div
        v-if="showCreateServerHint"
        class="flex items-center justify-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-200"
      >
        <span>你还没有自己的服务器</span>
        <button
          class="rounded-md bg-blue-600 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-blue-700"
          @click="router.push('/onboarding/server')"
        >
          创建你的服务器
        </button>
        <button class="text-blue-500 hover:text-blue-700" aria-label="暂时关闭" @click="dismissCreateServerHint">
          <X class="h-4 w-4" />
        </button>
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
