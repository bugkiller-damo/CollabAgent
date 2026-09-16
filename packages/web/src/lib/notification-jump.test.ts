import { describe, expect, it } from "vitest";
import type { NotificationItem } from "../stores/notificationStore";
import { resolveNotificationRoute } from "./notification-jump";

const base: NotificationItem = {
  id: "n1",
  type: "@mention",
  actorId: "u2",
  actorName: "alice",
  channelId: "ch-uuid-1",
  messageId: "msg-1",
  title: "alice 在消息中提到了你",
  body: "hello",
  metadata: null,
  read: false,
  createdAt: new Date().toISOString(),
};

const channels = [{ id: "ch-uuid-1", name: "general" }];

describe("resolveNotificationRoute", () => {
  it("@mention：metadata.channelName + messageId → 频道 hash 深链", () => {
    const r = resolveNotificationRoute({ ...base, metadata: { channelName: "dev" } }, channels);
    expect(r).toBe("/channels/dev#msg-1");
  });

  it("@mention 旧数据无 metadata：按 channelId 从频道列表兜底解析", () => {
    const r = resolveNotificationRoute(base, channels);
    expect(r).toBe("/channels/general#msg-1");
  });

  it("无 messageId 时只跳频道不带 hash", () => {
    const r = resolveNotificationRoute({ ...base, messageId: null, metadata: { channelName: "dev" } }, channels);
    expect(r).toBe("/channels/dev");
  });

  it("dm → /dm/<发送方>", () => {
    const r = resolveNotificationRoute({ ...base, type: "dm", actorName: "bob" }, channels);
    expect(r).toBe("/dm/bob");
  });

  it("task_assigned → /tasks/<频道名>", () => {
    const r = resolveNotificationRoute(
      { ...base, type: "task_assigned", messageId: null, metadata: { channelName: "dev", taskNumber: 3 } },
      channels,
    );
    expect(r).toBe("/tasks/dev");
  });

  it("无频道上下文（如 patrol_paused）→ null 不跳转", () => {
    const r = resolveNotificationRoute(
      { ...base, type: "patrol_paused", channelId: null, messageId: null, metadata: { reminderId: "r1" } },
      channels,
    );
    expect(r).toBeNull();
  });

  it("channelId 在频道列表里找不到 → null", () => {
    const r = resolveNotificationRoute({ ...base, channelId: "gone" }, channels);
    expect(r).toBeNull();
  });
});
