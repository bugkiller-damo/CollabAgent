import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

import { useChannelStore } from "./channelStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

// 未读计数 key 约定 = "<serverId>:<频道裸名>"（serverId 为空时退化为 ":<名>"）——
// 跨 server 同名频道（两边都有 general）不串桶；写/清/读三侧统一走 unreadKeyFor
// （P1-9 教训延续：wsDispatch 写、ChatPane 读、setActiveChannel 清单点归一化）
describe("channelStore 未读计数 key 归一化", () => {
  it("incrementUnread 去 # 前缀：同 server 下 '#general' 与 'general' 落同 key", () => {
    const store = useChannelStore();
    store.incrementUnread("s1", "#general");
    store.incrementUnread("s1", "general");

    expect(store.unreadCounts["s1:general"]).toBe(2);
    expect(store.unreadCounts["s1:#general"]).toBeUndefined();
  });

  it("不同 server 同名频道分桶，互不干扰", () => {
    const store = useChannelStore();
    store.incrementUnread("s1", "general");
    store.incrementUnread("s2", "general");
    store.incrementUnread("s2", "general");

    expect(store.unreadCounts["s1:general"]).toBe(1);
    expect(store.unreadCounts["s2:general"]).toBe(2);
  });

  it("clearUnread 按 (serverId, name) 清：其他 server 同名频道不受影响", () => {
    const store = useChannelStore();
    store.incrementUnread("s1", "general");
    store.incrementUnread("s2", "general");

    store.clearUnread("s1", "#general");
    expect(store.unreadCounts["s1:general"]).toBe(0);
    expect(store.unreadCounts["s2:general"]).toBe(1);
  });

  it("setActiveChannel 用 store.serverId 清当前 server 的未读", () => {
    const store = useChannelStore();
    store.resetForServer("s1");
    store.incrementUnread("s1", "random");
    store.incrementUnread("s2", "random");

    store.setActiveChannel("random");
    expect(store.unreadCounts["s1:random"]).toBe(0);
    expect(store.unreadCounts["s2:random"]).toBe(1);
    expect(store.activeChannelName).toBe("random");
  });

  it("无 serverId（单租户/未解析广播）退化为 ':name' key，读写同口径", () => {
    const store = useChannelStore();
    store.incrementUnread(null, "general");

    expect(store.unreadCounts[":general"]).toBe(1);
    expect(store.unreadKeyFor(null, "#general")).toBe(":general");
  });
});
