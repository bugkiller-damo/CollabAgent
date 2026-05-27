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

const savedUser = (() => {
  try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
})();

export const useAuthStore = create<AuthState>((set) => ({
  user: savedUser,
  token: localStorage.getItem("auth_token") || null,
  isAuthenticated: !!localStorage.getItem("auth_token"),

  login: async (login, password, rememberMe = false) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password, rememberMe }),
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
  },

  logout: () => {
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
