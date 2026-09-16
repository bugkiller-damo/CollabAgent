import type { NotificationItem } from "../stores/notificationStore";

interface ChannelLike {
  id: string;
  name: string;
}

/**
 * 通知 → 跳转目标路由。ActivityView（动态页）与 NotificationBell（铃铛面板）共用。
 *
 * - dm → /dm/<发送方 handle>（DM 频道无频道名，对端即 actor）
 * - task_assigned → /tasks/<频道名>（看板定位到该频道）
 * - 其余带频道上下文的（@mention 等）→ /channels/<名>#<消息id>，
 *   hash 由 ChannelView 的 locate 回填逻辑居中高亮（P1-12 基建）
 * - 2026-09-17 之前的旧通知行没有 metadata.channelName：按 channelId 从
 *   已加载频道列表兜底解析；解析不出（如频道已删）返回 null，点击不跳转
 */
export function resolveNotificationRoute(n: NotificationItem, channels: ChannelLike[]): string | null {
  const meta = (n.metadata ?? {}) as Record<string, unknown>;
  if (n.type === "dm") {
    return n.actorName ? `/dm/${n.actorName}` : null;
  }
  if (n.type === "task_assigned" && typeof meta.channelName === "string" && meta.channelName) {
    return `/tasks/${meta.channelName}`;
  }
  let channelName = typeof meta.channelName === "string" && meta.channelName ? meta.channelName : undefined;
  if (!channelName && n.channelId) {
    channelName = channels.find((c) => c.id === n.channelId)?.name;
  }
  if (!channelName) return null;
  return `/channels/${channelName}${n.messageId ? `#${n.messageId}` : ""}`;
}
