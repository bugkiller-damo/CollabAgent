import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from "../api";
import { claudeInstalled, runtimeCatalog, useComputerStore } from "./computerStore";

const apiGetMock = vi.mocked(apiGet);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

const row = (over: Record<string, unknown>) => ({
  id: "c1",
  userId: "u1",
  serverId: "s1",
  machineUuid: "mu-1",
  name: "灵耀14air",
  description: "",
  hostname: "host",
  os: "win32",
  arch: "x64",
  daemonVersion: "0.1.0",
  lastReadyAt: null,
  createdAt: null,
  online: false,
  runtimes: [],
  connectedAt: null,
  ownerHandle: null,
  ownerName: null,
  mine: true,
  ...over,
});

// 2026-09-19 server-scoped computers：store 从单机状态对象改为「活跃 server 计算机列表」
describe("computerStore.refresh（server 语境列表）", () => {
  it("GET /api/computers 成功 → 列表落 store，mine 分组就绪", async () => {
    apiGetMock.mockResolvedValueOnce({
      computers: [row({ id: "a" }), row({ id: "b", mine: false, online: true }), row({ id: "c", online: true })],
    } as any);

    const store = useComputerStore();
    const r = await store.refresh();

    expect(apiGetMock).toHaveBeenCalledWith("/api/computers");
    expect(r).toHaveLength(3);
    expect(store.computers).toHaveLength(3);
    expect(store.myComputers.map((c) => c.id)).toEqual(["a", "c"]);
    expect(store.connected).toBe(true); // c 在线
    expect(store.loaded).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("端点失败 → 空列表不抛错（空态交给页面引导）", async () => {
    apiGetMock.mockRejectedValueOnce(new Error("400 serverId required"));

    const store = useComputerStore();
    const r = await store.refresh();

    expect(r).toEqual([]);
    expect(store.computers).toEqual([]);
    expect(store.myComputers).toEqual([]);
    expect(store.connected).toBe(false);
    expect(store.loaded).toBe(true);
  });

  it("connected = 我在本 server 任一机器在线；他人机器不计", async () => {
    apiGetMock.mockResolvedValueOnce({ computers: [row({ mine: false, online: true })] } as any);
    const store = useComputerStore();
    await store.refresh();
    expect(store.connected).toBe(false);
  });

  it("Phase 4：bridgeRuntimes flag 透传（缺省 false）", async () => {
    apiGetMock.mockResolvedValueOnce({ computers: [], bridgeRuntimes: true } as any);
    const store = useComputerStore();
    await store.refresh();
    expect(store.bridgeRuntimes).toBe(true);

    apiGetMock.mockResolvedValueOnce({ computers: [] } as any);
    await store.refresh();
    expect(store.bridgeRuntimes).toBe(false);
  });

  it("Phase 4：entrypoints 字段随行保留", async () => {
    const eps = [
      {
        id: "ep-sel",
        label: "LG",
        runtime: "langgraph",
        status: "installed_unsupported",
        modelMode: "select",
        models: ["openai:gpt-5-mini"],
        defaultModel: "openai:gpt-5-mini",
      },
    ];
    apiGetMock.mockResolvedValueOnce({ computers: [row({ entrypoints: eps })] } as any);
    const store = useComputerStore();
    await store.refresh();
    expect(store.computers[0].entrypoints).toEqual(eps);
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

  it("runtimeCatalog：四个 binary + 两个 bridge runtime", () => {
    const cat = runtimeCatalog();
    expect(cat.map((r) => r.id)).toEqual(["claude", "codex", "gemini", "opencode", "langchain", "langgraph"]);
    expect(cat.filter((r) => r.kind === "bridge").map((r) => r.id)).toEqual(["langchain", "langgraph"]);
  });
});
