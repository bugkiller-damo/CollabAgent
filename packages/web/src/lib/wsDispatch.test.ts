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

    // 预置一条 pending（模拟本地乐观发送）
    const pending = messageStore.enqueuePending("#general", "hello", undefined);
    expect(messageStore.pendingByTarget["#general"]).toHaveLength(1);

    dispatchWsEvent({
      type: "agent:deliver",
      message: {
        id: "m-1",
        seq: 42,
        channelId: "#general", // server 真实广播形状（messages.ts: "#"+name）
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

    const payload = {
      type: "agent:deliver",
      message: {
        id: "m-dup",
        seq: 7,
        channelId: "#general",
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

  // P0-2：线程回复链路——①守卫拦截主列表 ②直写线程缓冲区 ③key 无 # 与 ThreadView 同口径
  it("agent:deliver 线程回复 → 不进主列表、不推进主列表水位，进无 # 线程缓冲区", () => {
    const messageStore = useMessageStore();
    const channelStore = useChannelStore();
    channelStore.channels = [{ id: "ch-uuid-1", name: "general" } as any];
    // 既有顶层消息：主列表水位 10
    messageStore.receiveMessage({
      id: "m-top",
      seq: 10,
      channelId: "#general",
      senderId: "u-1",
      senderName: "alice",
      senderType: "human",
      content: "顶层",
      time: "t",
    } as any);

    dispatchWsEvent({
      type: "agent:deliver",
      message: {
        id: "m-r1",
        seq: 11,
        channelId: "#general", // server 真实广播形状（messages.ts: "#"+name）
        senderId: "u-2",
        senderName: "bob",
        senderType: "human",
        content: "线程里聊",
        time: "2026-09-04T00:00:00Z",
        threadId: "12345678-1234-1234-1234-123456789abc",
      },
    } as any);

    // ① 守卫拦截：线程回复不漏进主列表
    expect(messageStore.messagesByTarget["#general"].map((m) => m.id)).toEqual(["m-top"]);
    // ② 主列表水位不被线程回复推进（否则重连 backfill after=11 会跳过其间未到达的顶层消息）
    expect(messageStore.lastSeenSeq["#general"]).toBe(10);
    // ③ 线程缓冲区 key 无 #（ThreadView threadKey = general:12345678）
    const buf = messageStore.messagesByTarget["general:12345678"] ?? [];
    expect(buf).toHaveLength(1);
    expect(buf[0].id).toBe("m-r1");
    expect(buf[0].content).toBe("线程里聊");
  });

  it("agent:deliver 线程回复重复投递 → 缓冲区按 id 去重", () => {
    const messageStore = useMessageStore();
    const payload = {
      type: "agent:deliver",
      message: {
        id: "m-r2",
        seq: 12,
        channelId: "#general",
        senderId: "u-2",
        senderName: "bob",
        senderType: "human",
        content: "dup",
        time: "t",
        threadId: "abcdef00-0000-0000-0000-000000000000",
      },
    } as any;
    dispatchWsEvent(payload);
    dispatchWsEvent(payload);
    expect(messageStore.messagesByTarget["general:abcdef00"]).toHaveLength(1);
  });

  it("agent:deliver DM 线程回复 → key 为 dm:<uuid>:<tid8>（MessageRow 的 /channels/dm:uuid/<id> 入口同口径）", () => {
    const messageStore = useMessageStore();
    dispatchWsEvent({
      type: "agent:deliver",
      message: {
        id: "m-r3",
        seq: 13,
        channelId: "dm:dm-uuid-1",
        senderId: "a-1",
        senderName: "agent",
        senderType: "agent",
        content: "dm 线程回复",
        time: "t",
        threadId: "99999999-0000-0000-0000-000000000000",
        dm: true,
      },
    } as any);
    expect(messageStore.messagesByTarget["dm:dm-uuid-1"] ?? []).toHaveLength(0);
    expect(messageStore.messagesByTarget["dm:dm-uuid-1:99999999"]).toHaveLength(1);
  });

  // P1-9：未读计数 key 统一裸名 + 正在看的频道不计 + DM 走通知链路不计频道未读
  function deliver(channelId: string, id: string, threadId?: string) {
    dispatchWsEvent({
      type: "agent:deliver",
      message: {
        id,
        seq: 1,
        channelId,
        senderId: "u-2",
        senderName: "bob",
        senderType: "human",
        content: "hi",
        time: "t",
        ...(threadId ? { threadId } : {}),
      },
    } as any);
  }

  it("非当前频道投递 → 未读 +1 且 key 为裸名（与 ChatPane 读侧 unreadCounts[ch.name] 同口径）", () => {
    const channelStore = useChannelStore();
    channelStore.setActiveChannel("general");

    deliver("#random", "m-u1");
    deliver("#random", "m-u2");

    expect(channelStore.unreadCounts.random).toBe(2);
    expect(channelStore.unreadCounts["#random"]).toBeUndefined(); // 无 #-前缀 key 残留
  });

  it("正在看的频道不计未读（此前 ch 反查恒 undefined，active 频道也累计进聚合徽标）", () => {
    const channelStore = useChannelStore();
    channelStore.setActiveChannel("general");

    deliver("#general", "m-u3");

    expect(channelStore.unreadCounts.general ?? 0).toBe(0);
  });

  it("未打开任何频道（activeChannelName=null）也正常累计——守卫不再以 activeChannelName 为前提", () => {
    const channelStore = useChannelStore();

    deliver("#random", "m-u4");

    expect(channelStore.unreadCounts.random).toBe(1);
  });

  it("DM 投递不计频道未读（无 per-DM 徽标消费方；DM 提醒走 type:dm 通知链路）", () => {
    const channelStore = useChannelStore();

    deliver("dm:dm-uuid-9", "m-u5");

    expect(channelStore.unreadCounts).toEqual({});
  });

  it("线程回复仍计所属频道未读（频道有新活动，语义保留）", () => {
    const channelStore = useChannelStore();
    channelStore.setActiveChannel("general");

    deliver("#random", "m-u6", "12345678-1234-1234-1234-123456789abc");

    expect(channelStore.unreadCounts.random).toBe(1);
  });
});
