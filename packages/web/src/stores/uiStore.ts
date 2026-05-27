import { create } from "zustand";

interface UiState {
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  threadPanelTarget: string | null;
  theme: "light" | "dark" | "system";

  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  openThread: (target: string) => void;
  closeThread: () => void;
  setTheme: (theme: UiState["theme"]) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  rightPanelOpen: false,
  threadPanelTarget: null,
  theme: (localStorage.getItem("theme") as UiState["theme"]) || "system",

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  openThread: (target) => set({ threadPanelTarget: target }),
  closeThread: () => set({ threadPanelTarget: null }),
  setTheme: (theme) => {
    localStorage.setItem("theme", theme);
    set({ theme });
  },
}));
