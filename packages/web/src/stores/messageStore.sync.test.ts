import { describe, expect, it } from "vitest";

// 冒烟：验证 vitest 接入可用（store 纯逻辑测试不需要 DOM；
// 依赖 localStorage 的用例自行 stub globalThis.localStorage）。
describe("vitest harness", () => {
  it("runs store-logic style tests in node env", () => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as Storage;
    localStorage.setItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
  });
});
