import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapApiNotification, useNotificationStore } from "./notificationStore";

// W-A1：server REST 返回蛇形列名，WS 推送 camelCase；loadFromApi 入库前须经 mapApiNotification 归一，
// 否则 createdAt/channelId 为 undefined → NotificationBell「NaN天前」+ 点击不跳转。
describe("notificationStore W-A1：REST 蛇形列名归一", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mapApiNotification 蛇形 → camelCase，createdAt 可被 Date 解析（NaN天前回归）", () => {
    const n = mapApiNotification({
      id: "n-1",
      user_id: "u-1",
      type: "@mention",
      actor_id: "u-2",
      actor_name: "alice",
      channel_id: "c-1",
      message_id: "m-1",
      title: "提到了你",
      body: "hello",
      metadata: { channelName: "general" },
      read: false,
      created_at: "2026-09-04T01:00:00.000Z",
    });
    expect(n.actorId).toBe("u-2");
    expect(n.actorName).toBe("alice");
    expect(n.channelId).toBe("c-1");
    expect(n.messageId).toBe("m-1");
    expect(n.createdAt).toBe("2026-09-04T01:00:00.000Z");
    expect(Number.isNaN(new Date(n.createdAt).getTime())).toBe(false);
  });

  it("可空字段缺省归一为 null", () => {
    const n = mapApiNotification({
      id: "n-2",
      type: "dm",
      title: "t",
      read: true,
      created_at: "2026-09-04T01:00:00.000Z",
    });
    expect(n.actorName).toBeNull();
    expect(n.channelId).toBeNull();
    expect(n.messageId).toBeNull();
    expect(n.body).toBeNull();
    expect(n.metadata).toBeNull();
  });

  it("camelCase 输入兼容透传（server 契约收口后无需改动）", () => {
    const n = mapApiNotification({
      id: "n-3",
      type: "dm",
      actorId: "u-2",
      actorName: null,
      channelId: "c-1",
      messageId: null,
      title: "t",
      body: null,
      metadata: null,
      read: false,
      createdAt: "2026-09-04T02:00:00.000Z",
    });
    expect(n.actorId).toBe("u-2");
    expect(n.channelId).toBe("c-1");
    expect(n.createdAt).toBe("2026-09-04T02:00:00.000Z");
  });

  it("loadFromApi 经映射入库：REST 蛇形行不再产生 undefined 字段（点击跳转回归）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          notifications: [
            {
              id: "n-1",
              type: "@mention",
              actor_id: "u-2",
              actor_name: "alice",
              channel_id: "c-1",
              message_id: "m-1",
              title: "提到了你",
              body: null,
              metadata: { channelName: "general" },
              read: false,
              created_at: "2026-09-04T01:00:00.000Z",
            },
          ],
          unreadCount: 1,
          hasMore: false,
        }),
      }),
    );
    const store = useNotificationStore();
    await store.loadFromApi();
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0].channelId).toBe("c-1");
    expect(store.notifications[0].createdAt).toBe("2026-09-04T01:00:00.000Z");
    expect(store.unreadCount).toBe(1);
    expect(store.hasMore).toBe(false);
  });
});
