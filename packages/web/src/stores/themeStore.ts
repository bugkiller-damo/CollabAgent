import { create } from "zustand";

type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const saved = (typeof window !== "undefined" ? localStorage.getItem("theme") : null) as Theme | null;
const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
const initial: Theme = saved || (prefersDark ? "dark" : "light");

if (typeof document !== "undefined") {
  document.documentElement.classList.toggle("dark", initial === "dark");
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initial,
  toggle: () => set((s) => {
    const next = s.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
    return { theme: next };
  }),
  setTheme: (t: Theme) => {
    localStorage.setItem("theme", t);
    document.documentElement.classList.toggle("dark", t === "dark");
    set({ theme: t });
  },
}));
