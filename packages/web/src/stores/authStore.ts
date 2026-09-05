import { defineStore } from "pinia";
import { ref } from "vue";
import { readCsrf } from "../api";
import { clearMessageCaches } from "../lib/message-cache";

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
  try {
    return JSON.parse(store?.getItem("user") || "null");
  } catch {
    return null;
  }
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
    // #19 口径：明文缓存=切频道/刷新不丢的 UX 权衡，但跨账号残留不属权衡内——
    // 登出即清 localStorage 消息缓存与离线队列，并联动清 messageStore 内存态
    //（SPA 登出不整页刷新，内存态不清则 in-flight flush 失败会把旧账号草稿
    // 重写回 localStorage，旧缓存消息也会在新账号频道闪现）
    clearMessageCaches();
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
