import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { dispatchWsEvent } from "./wsDispatch";

// O16：事件路由单测——store 只消费事件。重点回归 O15 胶水：
// agent:deliver 带 clientNonce 时先调和 pending 乐观行，再按 id 去重入列。

vi.mock("../api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiClient: vi.fn(),
}));

function stubLocalStorage() {
  const map = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe("wsDispatch", () => {
  it("agent:deliver → 消息入列 + clientNonce 调和 pending 乐观行", () => {
    const messageStore = useMessageStore();
    const channelStore = useChannelStore();
    channelStore.channels = [{ id: "ch-uuid-1", name: "general" } as any];

    // 预置一条 pending（模拟本地乐观发送）
    const pending = messageStore.enqueuePending("#general", "hello", undefined);
    expect(messageStore.pendingByTarget["#general"]).toHaveLength(1);

    dispatchWsEvent({
      type: "agent:deliver",
      message: {
        id: "m-1",
        seq: 42,
        channelId: "ch-uuid-1", // 服务端给的是频道 UUID，路由层映射回 #name
        senderId: "u-1",
        senderName: "me",
        senderType: "human",
        content: "hello",
        time: "2026-08-18T00:00:00Z",
        clientNonce: pending.nonce,
      },
    } as any);

    // pending 乐观行被调和移除，消息按 #general 键入列
    expect(messageStore.pendingByTarget["#general"] ?? []).toHaveLength(0);
    const msgs = messageStore.messagesByTarget["#general"] ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("m-1");
    expect(messageStore.lastSeenSeq["#general"]).toBe(42);
  });

  it("agent:deliver 重复投递同 id → 去重不重复入列", () => {
    const messageStore = useMessageStore();
    const channelStore = useChannelStore();
    channelStore.channels = [{ id: "ch-uuid-1", name: "general" } as any];

    const payload = {
      type: "agent:deliver",
      message: {
        id: "m-dup",
        seq: 7,
        channelId: "ch-uuid-1",
        senderId: "u-1",
        senderName: "me",
        senderType: "human",
        content: "x",
        time: "2026-08-18T00:00:00Z",
      },
    } as any;
    dispatchWsEvent(payload);
    dispatchWsEvent(payload);
    expect(messageStore.messagesByTarget["#general"]).toHaveLength(1);
  });

  it("message:update / message:delete 路由到 store 修订", () => {
    const messageStore = useMessageStore();
    const channelStore = useChannelStore();
    channelStore.channels = [{ id: "ch-uuid-1", name: "general" } as any];
    messageStore.receiveMessage({
      id: "m-9",
      seq: 1,
      channelId: "#general",
      senderId: "u",
      senderName: "n",
      senderType: "human",
      content: "old",
      time: "t",
    } as any);

    dispatchWsEvent({ type: "message:update", message: { id: "m-9", content: "new", editedAt: "e" } } as any);
    expect(messageStore.messagesByTarget["#general"][0].content).toBe("new");

    dispatchWsEvent({ type: "message:delete", message: { id: "m-9" } } as any);
    expect((messageStore.messagesByTarget["#general"][0] as any).deleted).toBe(true);
  });
});
