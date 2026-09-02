import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../stores/agentStore";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useTerminalStore } from "../stores/terminalStore";
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

  it("terminal:history / obs-frame 写入 terminalStore", () => {
    const terminalStore = useTerminalStore();
    dispatchWsEvent({
      type: "terminal:history",
      agentName: "alice",
      text: "log-tail",
    } as any);
    expect(terminalStore.histories.alice).toBe("log-tail");

    dispatchWsEvent({
      type: "terminal:obs-frame",
      agentName: "alice",
      frame: { agentName: "alice", seq: 1, timestamp: 1, kind: "text", turnId: null, payload: { text: "hi" } },
    } as any);
    expect(terminalStore.obsFrames.alice).toHaveLength(1);
    expect(terminalStore.obsFrames.alice[0].payload.text).toBe("hi");
  });

  it("agent:progress 写入频道顶栏状态", () => {
    const agentStore = useAgentStore();
    dispatchWsEvent({
      type: "agent:progress",
      agentName: "alice",
      channelName: "general",
      headline: "读文件 login.ts",
      phase: "update",
    } as any);
    expect(agentStore.progressByChannel.general.headline).toContain("读文件");
    dispatchWsEvent({
      type: "agent:progress",
      agentName: "alice",
      channelName: "general",
      headline: "",
      phase: "end",
    } as any);
    expect(agentStore.progressByChannel.general).toBeUndefined();
  });

  it("agent:presence 写入 duty / presence", () => {
    const agentStore = useAgentStore();
    dispatchWsEvent({
      type: "agent:presence",
      agentId: "id-1",
      agentName: "coder",
      duty: "off",
      computerOnline: true,
      presence: "off_duty",
    } as any);
    expect(agentStore.agents.coder.duty).toBe("off");
    expect(agentStore.agents.coder.presence).toBe("off_duty");
  });

  it("message:delete 进度条从列表移除", () => {
    const messageStore = useMessageStore();
    messageStore.receiveMessage({
      id: "m-p",
      seq: 2,
      channelId: "#general",
      senderId: "a",
      senderName: "alice",
      senderType: "agent",
      content: "⏳ 正在读文件…",
      time: "t",
    } as any);
    dispatchWsEvent({ type: "message:delete", message: { id: "m-p" } } as any);
    expect(messageStore.messagesByTarget["#general"].find((m: any) => m.id === "m-p")).toBeUndefined();
  });

  // P1.25：已读多端同步——notification.read 按 ids / all 两形态路由到 notificationStore
  it("notification.read（ids）→ 指定通知标记已读，未读数递减", () => {
    const notificationStore = useNotificationStore();
    notificationStore.setNotifications([
      {
        id: "n-1",
        type: "dm",
        actorId: "a",
        actorName: null,
        channelId: null,
        messageId: null,
        title: "t1",
        body: null,
        metadata: null,
        read: false,
        createdAt: "t",
      },
      {
        id: "n-2",
        type: "dm",
        actorId: "a",
        actorName: null,
        channelId: null,
        messageId: null,
        title: "t2",
        body: null,
        metadata: null,
        read: false,
        createdAt: "t",
      },
    ] as any);
    notificationStore.setUnreadCount(2);

    dispatchWsEvent({ type: "notification.read", ids: ["n-1"], all: false } as any);
    const items = notificationStore.notifications;
    expect(items.find((n) => n.id === "n-1")!.read).toBe(true);
    expect(items.find((n) => n.id === "n-2")!.read).toBe(false);
    expect(notificationStore.unreadCount).toBe(1);
  });

  it("notification.read（all）→ 全部已读；重复广播幂等", () => {
    const notificationStore = useNotificationStore();
    notificationStore.setNotifications([
      {
        id: "n-1",
        type: "dm",
        actorId: "a",
        actorName: null,
        channelId: null,
        messageId: null,
        title: "t1",
        body: null,
        metadata: null,
        read: false,
        createdAt: "t",
      },
      {
        id: "n-2",
        type: "dm",
        actorId: "a",
        actorName: null,
        channelId: null,
        messageId: null,
        title: "t2",
        body: null,
        metadata: null,
        read: false,
        createdAt: "t",
      },
    ] as any);
    notificationStore.setUnreadCount(2);

    dispatchWsEvent({ type: "notification.read", ids: null, all: true } as any);
    expect(notificationStore.notifications.every((n) => n.read)).toBe(true);
    expect(notificationStore.unreadCount).toBe(0);

    // 重复广播（其他标签页各标记一次）：幂等，不把计数打成负数
    dispatchWsEvent({ type: "notification.read", ids: null, all: true } as any);
    expect(notificationStore.unreadCount).toBe(0);
  });
});
