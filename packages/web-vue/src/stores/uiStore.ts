import { ref } from "vue";
import { defineStore } from "pinia";

export type Theme = "dark" | "light" | "system";

export type WsStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

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
  };
});
