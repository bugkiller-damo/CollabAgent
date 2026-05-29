import { create } from "zustand";

type Theme = "dark" | "light" | "system";

interface UiState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
}

const getInitialTheme = (): Theme => {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return "dark";
};

export const useUiStore = create<UiState>((set) => ({
  theme: getInitialTheme(),

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
