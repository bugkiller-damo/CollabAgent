import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "../api";
import { claudeInstalled, runtimeCatalog, useComputerStore } from "./computerStore";

const apiGetMock = vi.mocked(apiGet);
const apiPostMock = vi.mocked(apiPost);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

// 双端点降级链（审计 §2.3：computerStore 双端点降级）
describe("computerStore.refresh 三级降级", () => {
  it("主端点 /api/computers/me 成功 → 直用且 loading 复位", async () => {
    const me = { connected: true, runtimes: [], computer: { id: "c1" } };
    apiGetMock.mockResolvedValueOnce(me as any);

    const store = useComputerStore();
    const r = await store.refresh();

    expect(apiGetMock).toHaveBeenCalledWith("/api/computers/me");
    expect(r).toEqual(me);
    expect(store.status).toEqual(me);
    expect(store.loading).toBe(false);
    expect(store.connected).toBe(true);
  });

  it("主端点失败 → 降级 /api/daemon/status，computer 字段 null 归一", async () => {
    const d = { connected: true, runtimes: [] }; // 无 computer 字段
    apiGetMock.mockRejectedValueOnce(new Error("404")).mockResolvedValueOnce(d as any);

    const store = useComputerStore();
    const r = await store.refresh();

    expect(apiGetMock).toHaveBeenNthCalledWith(1, "/api/computers/me");
    expect(apiGetMock).toHaveBeenNthCalledWith(2, "/api/daemon/status");
    expect(r?.computer).toBeNull(); // d.computer ?? null
    expect(store.connected).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("双端点均失败 → connected:false 兜底对象（不抛错）", async () => {
    apiGetMock.mockRejectedValue(new Error("down"));

    const store = useComputerStore();
    const r = await store.refresh();

    expect(r?.connected).toBe(false);
    expect(r?.runtimes).toEqual([]);
    expect(r?.computer).toBeNull();
    expect(store.connected).toBe(false);
    expect(store.loading).toBe(false);
  });
});

describe("computerStore.ensure", () => {
  it("POST /api/computers 并更新 status", async () => {
    const created = { connected: true, computer: { id: "new" } };
    apiPostMock.mockResolvedValueOnce(created as any);

    const store = useComputerStore();
    const r = await store.ensure();

    expect(apiPostMock).toHaveBeenCalledWith("/api/computers", {});
    expect(r).toEqual(created);
    expect(store.computer).toEqual({ id: "new" });
  });
});

describe("runtime 判定 helpers", () => {
  it("claudeInstalled：仅 claude 且 installed 才为真", () => {
    expect(claudeInstalled([{ id: "claude", status: "installed" }])).toBe(true);
    expect(claudeInstalled([{ id: "claude", status: "not_installed" }])).toBe(false);
    expect(claudeInstalled([{ id: "codex", status: "installed" }])).toBe(false);
    expect(claudeInstalled([])).toBe(false);
    expect(
      claudeInstalled([
        { id: "claude", status: "installed" },
        { id: "codex", status: "installed" },
      ]),
    ).toBe(true);
  });

  it("runtimeCatalog：四运行时目录", () => {
    expect(runtimeCatalog().map((r) => r.id)).toEqual(["claude", "codex", "gemini", "opencode"]);
  });
});
