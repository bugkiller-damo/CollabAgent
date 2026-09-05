import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// authStore 不 mock ../api：readCsrf 真实运行（node 无 document → null；
// 需要测 CSRF 头的用例单独 stub document）
import { useAuthStore } from "./authStore";

// 模块级 savedUser 仅在 import 时求值：node 无 localStorage → 静态 import 恒为未登录。
// 持久化恢复用例在测试内 stub window+localStorage 后 vi.resetModules() 动态重导入。
function makeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  } as unknown as Storage;
}

function okResponse(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), { status });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("localStorage", makeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("authStore.login", () => {
  it("成功：写 localStorage user 镜像 + 置登录态", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ user: { id: "u1", handle: "alice", displayName: "Alice" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = useAuthStore();
    await store.login("alice", "pw123", true);

    expect(store.isAuthenticated).toBe(true);
    expect(store.user).toEqual({ id: "u1", handle: "alice", displayName: "Alice" });
    expect(localStorage.getItem("user")).toBe(JSON.stringify({ id: "u1", handle: "alice", displayName: "Alice" }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ handle: "alice", password: "pw123", remember: true });
  });

  it("失败：透传 server error 文案，且不写镜像不置登录态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ error: "用户名或密码错误" }, 401)),
    );

    const store = useAuthStore();
    await expect(store.login("alice", "bad")).rejects.toThrow("用户名或密码错误");
    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
  });
});

describe("authStore.logout / updateUser", () => {
  it("logout：清镜像 + 置未登录，并 POST /api/auth/logout 携 CSRF 头（cookie 在时）", () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: "csrf_token=tok123" });

    const store = useAuthStore();
    store.updateUser({ id: "u1", handle: "alice" });
    expect(store.user?.handle).toBe("alice"); // updateUser 只写 user（审计 §2.3：登录态仅由 login/镜像恢复驱动）

    store.logout();

    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok123");
  });

  it("logout：无 csrf cookie → 不带 CSRF 头（仍清本地态）", () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const store = useAuthStore();
    store.logout();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect(store.user).toBeNull();
  });

  it("updateUser：浅合并既有字段并持久化", () => {
    const store = useAuthStore();
    store.updateUser({ id: "u1", handle: "alice" });
    store.updateUser({ displayName: "Alice A" });

    expect(store.user).toEqual({ id: "u1", handle: "alice", displayName: "Alice A" });
    expect(JSON.parse(localStorage.getItem("user")!)).toEqual({
      id: "u1",
      handle: "alice",
      displayName: "Alice A",
    });
  });
});

describe("authStore 持久化镜像恢复（模块级 savedUser，动态重导入）", () => {
  it("刷新后从 localStorage user 恢复登录态（审计 §2.3：cookie 会话 + localStorage 镜像）", async () => {
    const storage = makeStorage();
    storage.setItem("user", JSON.stringify({ id: "u1", handle: "alice" }));
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();

    const mod = await import("./authStore");
    setActivePinia(createPinia());
    const store = mod.useAuthStore();
    expect(store.isAuthenticated).toBe(true);
    expect(store.user?.handle).toBe("alice");
  });

  it("镜像损坏（非法 JSON）按未登录处理，不炸", async () => {
    const storage = makeStorage();
    storage.setItem("user", "{bad json");
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();

    const mod = await import("./authStore");
    setActivePinia(createPinia());
    const store = mod.useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
  });
});
