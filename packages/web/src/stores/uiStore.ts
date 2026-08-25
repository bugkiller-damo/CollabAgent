import { defineStore } from "pinia";
import { ref } from "vue";

export type Theme = "dark" | "light" | "system";

export type WsStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export type SidebarPane = "search" | "chat" | "activity" | "tasks" | "people" | "computers";

export interface ProfileTarget {
  handle: string;
  channelId?: string;
}

const SIDEBAR_PANES: readonly SidebarPane[] = ["search", "chat", "activity", "tasks", "people", "computers"];
/** 搜索 / 动态 / 成员走独立主区页，不占 240px pane */
const PANELESS_SIDEBAR: ReadonlySet<SidebarPane> = new Set(["search", "activity", "people"]);
const SIDEBAR_STORAGE_KEY = "slock.sidebar";

export function hasSidebarDetailPane(pane: SidebarPane): boolean {
  return !PANELESS_SIDEBAR.has(pane);
}

function getInitialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return "dark";
}

function updateHtmlClass(theme: Theme) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

function isSidebarPane(v: unknown): v is SidebarPane {
  return typeof v === "string" && (SIDEBAR_PANES as readonly string[]).includes(v);
}

export function loadSidebarState(): { pane: SidebarPane; open: boolean } {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!raw) return { pane: "chat", open: true };
    const parsed = JSON.parse(raw) as { pane?: unknown; open?: unknown };
    return {
      pane: isSidebarPane(parsed.pane) ? parsed.pane : "chat",
      open: typeof parsed.open === "boolean" ? parsed.open : true,
    };
  } catch {
    return { pane: "chat", open: true };
  }
}

/**
 * 主题初始化唯一入口（收敛点）：main.ts 在挂载前调用一次。
 * 逻辑与 React 版 uiStore 模块加载时的 updateHtmlClass(getInitialTheme()) 一致：
 * localStorage "theme" 只认 light/dark，默认 dark。
 * （React 版 main.tsx 另有一套带 prefers-color-scheme 的 system 判定，与本处不一致；
 *  Vue 版以 uiStore 语义为准，不再双写。）
 */
export function initTheme(): void {
  updateHtmlClass(getInitialTheme());
}

export const useUiStore = defineStore("ui", () => {
  const theme = ref<Theme>(getInitialTheme());
  const wsStatus = ref<WsStatus>("connecting");
  const wsReconnectAttempt = ref(0);
  const online = ref(typeof navigator !== "undefined" ? navigator.onLine : true);
  /** 终端观察面板当前打开的 agent（null = 关闭） */
  const terminalAgent = ref<string | null>(null);
  /** 成员档案抽屉（同时只开一份；再点另一个人换内容） */
  const profileTarget = ref<ProfileTarget | null>(null);
  /** 档案「在此 @」：composer 消费后清空 */
  const pendingMention = ref<string | null>(null);

  const initialSidebar = loadSidebarState();
  const sidebarPane = ref<SidebarPane>(initialSidebar.pane);
  const sidebarOpen = ref(initialSidebar.open);
  /** lg 以下抽屉；与桌面 pane 开关独立 */
  const mobileDrawerOpen = ref(false);

  function persistSidebar(): void {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify({ pane: sidebarPane.value, open: sidebarOpen.value }));
    } catch {
      /* private mode / quota */
    }
  }

  function setWsStatus(status: WsStatus, reconnectAttempt?: number): void {
    wsStatus.value = status;
    wsReconnectAttempt.value = reconnectAttempt ?? wsReconnectAttempt.value;
  }

  function setOnline(v: boolean): void {
    online.value = v;
  }

  function openTerminal(agentName: string | null): void {
    terminalAgent.value = agentName;
  }

  function openProfile(target: ProfileTarget): void {
    profileTarget.value = { handle: target.handle.replace(/^@/, ""), channelId: target.channelId };
  }

  function closeProfile(): void {
    profileTarget.value = null;
  }

  function requestMention(handle: string): void {
    pendingMention.value = handle.replace(/^@/, "");
  }

  function consumeMention(): string | null {
    const h = pendingMention.value;
    pendingMention.value = null;
    return h;
  }

  function toggleTheme(): void {
    const next = theme.value === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    updateHtmlClass(next);
    theme.value = next;
  }

  function setTheme(t: Theme): void {
    localStorage.setItem("theme", t);
    updateHtmlClass(t);
    theme.value = t;
  }

  /** 路由同步：只改选中项；无二级栏的面强制收起 pane */
  function setSidebarPane(pane: SidebarPane): void {
    sidebarPane.value = pane;
    if (PANELESS_SIDEBAR.has(pane)) sidebarOpen.value = false;
    persistSidebar();
  }

  /** 强制打开某个 pane（⌘K 搜聊天频道列表等）；搜索/动态不展开二级栏 */
  function openSidebarPane(pane: SidebarPane): void {
    sidebarPane.value = pane;
    sidebarOpen.value = hasSidebarDetailPane(pane);
    persistSidebar();
  }

  /** rail 点击：有二级栏的项可折叠；搜索/动态只切面、关 pane */
  function selectSidebarPane(pane: SidebarPane): void {
    if (PANELESS_SIDEBAR.has(pane)) {
      sidebarPane.value = pane;
      sidebarOpen.value = false;
      persistSidebar();
      return;
    }
    if (sidebarPane.value === pane && sidebarOpen.value) {
      sidebarOpen.value = false;
    } else {
      sidebarPane.value = pane;
      sidebarOpen.value = true;
    }
    persistSidebar();
  }

  function toggleSidebar(): void {
    sidebarOpen.value = !sidebarOpen.value;
    persistSidebar();
  }

  function openMobileDrawer(pane?: SidebarPane): void {
    if (pane) sidebarPane.value = pane;
    if (!hasSidebarDetailPane(sidebarPane.value)) sidebarPane.value = "chat";
    mobileDrawerOpen.value = true;
    persistSidebar();
  }

  function closeMobileDrawer(): void {
    mobileDrawerOpen.value = false;
  }

  return {
    theme,
    toggleTheme,
    setTheme,
    wsStatus,
    wsReconnectAttempt,
    setWsStatus,
    online,
    setOnline,
    terminalAgent,
    openTerminal,
    profileTarget,
    openProfile,
    closeProfile,
    pendingMention,
    requestMention,
    consumeMention,
    sidebarPane,
    sidebarOpen,
    mobileDrawerOpen,
    setSidebarPane,
    openSidebarPane,
    selectSidebarPane,
    toggleSidebar,
    openMobileDrawer,
    closeMobileDrawer,
  };
});
