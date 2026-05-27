import { create } from "zustand";
import type { User, Agent } from "@collabagent/shared";

interface AuthState {
  user: User | null;
  agent: Agent | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithToken: (token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  agent: null,
  token: localStorage.getItem("auth_token"),
  isAuthenticated: !!localStorage.getItem("auth_token"),

  login: async (email, password) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error("Login failed");
    const data = await res.json();
    localStorage.setItem("auth_token", data.token);
    set({ user: data.user, token: data.token, isAuthenticated: true });
  },

  loginWithToken: (token) => {
    localStorage.setItem("auth_token", token);
    set({ token, isAuthenticated: true });
  },

  logout: () => {
    localStorage.removeItem("auth_token");
    set({ user: null, agent: null, token: null, isAuthenticated: false });
  },
}));
