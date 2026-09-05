import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_PREFIX, clearMessageCaches, onMessageCachesCleared, PENDING_CACHE_KEY } from "./message-cache";

// 与 messageStore 测试同款 stub 风格（globalThis.localStorage 直接赋值），但补齐 key(i)
function makeStorage(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed || {}));
  const storage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
  globalThis.localStorage = storage as unknown as Storage;
  return m;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // 模块级 registry 跨测试累积，用 resetModules 隔离
  vi.resetModules();
  // @ts-expect-error 测试清理：移除本文件设置的 globalThis.localStorage
  delete globalThis.localStorage;
});

describe("clearMessageCaches（#19 登出清盘）", () => {
  it("清 msgs_* 前缀全部 key + pending key，UI 偏好键保留", () => {
    makeStorage({
      "msgs_#general": "[1,2]",
      "msgs_dm:u1": "[3]",
      pending_msgs_v1: "{}",
      theme: "dark",
      user: '{"id":"u1"}',
      notif_prefs: "{}",
    });

    clearMessageCaches();

    expect(localStorage.getItem("msgs_#general")).toBeNull();
    expect(localStorage.getItem("msgs_dm:u1")).toBeNull();
    expect(localStorage.getItem(PENDING_CACHE_KEY)).toBeNull();
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(localStorage.getItem("user")).toBe('{"id":"u1"}');
  });

  it("无任何消息缓存时调用安全（空清盘）", () => {
    makeStorage({ theme: "dark" });
    expect(() => clearMessageCaches()).not.toThrow();
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("无 localStorage（node/SSR）直接返回不炸", () => {
    // @ts-expect-error 测试场景：移除全局 localStorage
    delete globalThis.localStorage;
    expect(() => clearMessageCaches()).not.toThrow();
  });

  it("localStorage 抛异常（quota/不可用）不炸，且回调仍执行", () => {
    globalThis.localStorage = {
      get length() {
        throw new Error("unavailable");
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("boom");
      },
      clear: () => {},
    } as unknown as Storage;

    const cb = vi.fn();
    onMessageCachesCleared(cb);
    expect(() => clearMessageCaches()).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1); // 存储异常不影响联动回调
  });

  it("onMessageCachesCleared：清盘触发全部注册回调；回调抛错不阻断其余回调", () => {
    makeStorage({});
    const calls: string[] = [];
    onMessageCachesCleared(() => {
      calls.push("a");
      throw new Error("cb-a boom"); // 故意抛错
    });
    onMessageCachesCleared(() => {
      calls.push("b");
    });

    clearMessageCaches();

    expect(calls).toEqual(["a", "b"]); // a 抛错后 b 仍执行
    expect(CACHE_PREFIX).toBe("msgs_"); // 常量契约（messageStore 同源）
  });
});
