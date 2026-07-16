import { create } from "zustand";
import { readCsrf } from "../api/client";

interface User {
  id: string;
  handle: string;
  displayName?: string;
  email?: string;
  description?: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  login: (login: string, password: string, rememberMe?: boolean) => Promise<void>;
  logout: () => void;
  updateUser: (u: Partial<User>) => void;
}

// 纯 httpOnly Cookie 鉴权：用户信息可缓存（仅展示用），不再用 JWT 作 Bearer 头
const store = typeof window !== "undefined" ? localStorage : null;
const savedUser = (() => {
  try { return JSON.parse(store?.getItem("user") || "null"); } catch { return null; }
})();

export const useAuthStore = create<AuthState>((set) => ({
  user: savedUser,
  isAuthenticated: !!savedUser,

  login: async (login, password, rememberMe = false) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: login, password, remember: rememberMe }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "登录失败");
    localStorage.setItem("user", JSON.stringify(data.user));
    set({ user: data.user, isAuthenticated: true });
  },

  logout: () => {
    const csrf = readCsrf();
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: csrf ? { "X-CSRF-Token": csrf } : {},
    }).catch(() => {});
    localStorage.removeItem("user");
    set({ user: null, isAuthenticated: false });
  },

  updateUser: (u) => {
    set((s) => {
      const updated = { ...s.user, ...u } as User;
      localStorage.setItem("user", JSON.stringify(updated));
      return { user: updated };
    });
  },
}));
