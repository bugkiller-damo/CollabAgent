import { create } from "zustand";

type Theme = "dark" | "light" | "system";

export type WsStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

interface UiState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  wsStatus: WsStatus;
  wsReconnectAttempt: number;
  setWsStatus: (status: WsStatus, reconnectAttempt?: number) => void;
  online: boolean;
  setOnline: (online: boolean) => void;
  /** 终端观察面板当前打开的 agent（null = 关闭） */
  terminalAgent: string | null;
  openTerminal: (agentName: string | null) => void;
}

const getInitialTheme = (): Theme => {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return "dark";
};

export const useUiStore = create<UiState>((set) => ({
  theme: getInitialTheme(),
  wsStatus: "connecting",
  wsReconnectAttempt: 0,
  setWsStatus: (status, reconnectAttempt) =>
    set((s) => ({ wsStatus: status, wsReconnectAttempt: reconnectAttempt ?? s.wsReconnectAttempt })),
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  setOnline: (online) => set({ online }),
  terminalAgent: null,
  openTerminal: (agentName) => set({ terminalAgent: agentName }),

  toggleTheme: () => {
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      updateHtmlClass(next);
      return { theme: next };
    });
  },

  setTheme: (t) => {
    localStorage.setItem("theme", t);
    updateHtmlClass(t);
    set({ theme: t });
  },
}));

function updateHtmlClass(theme: Theme) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

// Apply on load
updateHtmlClass(getInitialTheme());
