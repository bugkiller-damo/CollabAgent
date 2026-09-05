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

// P1-9：未读计数 key 约定 = 频道裸名（无 #），写/清两侧入口单点归一化——
// 防 wsDispatch（写）/ChatPane（读）/setActiveChannel（清）口径再次漂移
describe("channelStore 未读计数 key 归一化", () => {
  it("incrementUnread 去 # 前缀：写 '#general' 与写 'general' 落同 key", () => {
    const store = useChannelStore();
    store.incrementUnread("#general");
    store.incrementUnread("general");

    expect(store.unreadCounts.general).toBe(2);
    expect(store.unreadCounts["#general"]).toBeUndefined();
  });

  it("clearUnread 去 # 前缀：clearUnread('#general') 清掉裸名 key（setActiveChannel 路径同）", () => {
    const store = useChannelStore();
    store.incrementUnread("general");
    store.incrementUnread("random");

    store.clearUnread("#general");
    expect(store.unreadCounts.general).toBe(0);
    expect(store.unreadCounts.random).toBe(1); // 其他频道不受影响

    store.setActiveChannel("random"); // setActiveChannel 内部走 clearUnread
    expect(store.unreadCounts.random).toBe(0);
    expect(store.activeChannelName).toBe("random");
  });

  it("DM key（dm:<uuid>）原样保留，不被去 # 逻辑误伤", () => {
    const store = useChannelStore();
    store.incrementUnread("dm:uuid-1");
    store.clearUnread("dm:uuid-1");
    expect(store.unreadCounts["dm:uuid-1"]).toBe(0);
  });
});
