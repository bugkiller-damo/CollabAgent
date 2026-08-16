import { ref } from "vue";
import { defineStore } from "pinia";
import { readCsrf } from "../api";

interface User {
  id: string;
  handle: string;
  displayName?: string;
  email?: string;
  description?: string;
}

// 纯 httpOnly Cookie 鉴权：用户信息可缓存（仅展示用），不再用 JWT 作 Bearer 头
const store = typeof window !== "undefined" ? localStorage : null;
const savedUser = (() => {
  try { return JSON.parse(store?.getItem("user") || "null"); } catch { return null; }
})();

export const useAuthStore = defineStore("auth", () => {
  const user = ref<User | null>(savedUser);
  const isAuthenticated = ref(!!savedUser);

  async function login(loginName: string, password: string, rememberMe = false): Promise<void> {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: loginName, password, remember: rememberMe }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "登录失败");
    localStorage.setItem("user", JSON.stringify(data.user));
    user.value = data.user;
    isAuthenticated.value = true;
  }

  function logout(): void {
    const csrf = readCsrf();
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: csrf ? { "X-CSRF-Token": csrf } : {},
    }).catch(() => {});
    localStorage.removeItem("user");
    user.value = null;
    isAuthenticated.value = false;
  }

  function updateUser(u: Partial<User>): void {
    const updated = { ...user.value, ...u } as User;
    localStorage.setItem("user", JSON.stringify(updated));
    user.value = updated;
  }

  return { user, isAuthenticated, login, logout, updateUser };
});
