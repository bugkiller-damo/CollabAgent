import { create } from "zustand";

interface User {
  id: string;
  handle: string;
  displayName?: string;
  email?: string;
  description?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (login: string, password: string, rememberMe?: boolean) => Promise<void>;
  loginWithToken: (token: string) => void;
  logout: () => void;
  updateUser: (u: Partial<User>) => void;
}

const store = typeof window !== "undefined" ? localStorage : null;
const savedToken = store?.getItem("auth_token") || null;
const savedUser = (() => {
  try { return JSON.parse(store?.getItem("user") || "null"); } catch { return null; }
})();

export const useAuthStore = create<AuthState>((set) => ({
  user: savedUser,
  token: savedToken,
  isAuthenticated: !!savedToken,

  login: async (login, password, rememberMe = false) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: login, password, remember: rememberMe }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "登录失败");
    localStorage.setItem("auth_token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    set({ user: data.user, token: data.token, isAuthenticated: true });
  },

  loginWithToken: (token) => {
    localStorage.setItem("auth_token", token);
    set({ token, isAuthenticated: true });
    // Fetch user profile if token present
    fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } })
      .then(r => r.ok ? r.json() : null)
      .then(u => { if (u) { localStorage.setItem("user", JSON.stringify(u)); set({ user: u }); } })
      .catch(() => {});
  },

  logout: () => {
    // 通知服务端吊销当前会话并清 cookie（best-effort）
    const csrf = (() => {
      if (typeof document === "undefined") return null;
      for (const part of document.cookie.split(";")) {
        const i = part.indexOf("=");
        if (i >= 0 && part.slice(0, i).trim() === "csrf_token") return decodeURIComponent(part.slice(i + 1).trim());
      }
      return null;
    })();
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: csrf ? { "X-CSRF-Token": csrf } : {},
    }).catch(() => {});
    localStorage.removeItem("auth_token");
    localStorage.removeItem("user");
    set({ user: null, token: null, isAuthenticated: false });
  },

  updateUser: (u) => {
    set((s) => {
      const updated = { ...s.user, ...u } as User;
      localStorage.setItem("user", JSON.stringify(updated));
      return { user: updated };
    });
  },
}));
