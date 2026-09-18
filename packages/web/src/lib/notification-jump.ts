import type { NotificationItem } from "../stores/notificationStore";
import { channelPath, tasksPath } from "./nav";

interface ChannelLike {
  id: string;
  name: string;
}

/**
 * 通知 → 跳转目标路由。ActivityView（动态页）与 NotificationBell（铃铛面板）共用。
 *
 * - dm → /dm/<发送方 handle>（DM 频道无频道名，对端即 actor）
 * - task_assigned → /s/<serverId>/tasks/<频道名>（看板定位到该频道）
 * - 其余带频道上下文的（@mention 等）→ /s/<serverId>/channels/<名>#<消息id>，
 *   hash 由 ChannelView 的 locate 回填逻辑居中高亮（P1-12 基建）
 * - guild 化：新通知 metadata 带 serverId 时生成 server 段路径（跨 server
 *   同名频道精确落地）；旧行无 serverId → 回落旧 /channels|/tasks 路径，
 *   AppLayout 规范化 watcher 会套活跃 server（同名歧义退化为旧行为）
 */
export function resolveNotificationRoute(n: NotificationItem, channels: ChannelLike[]): string | null {
  const meta = (n.metadata ?? {}) as Record<string, unknown>;
  const serverId = typeof meta.serverId === "string" && meta.serverId ? meta.serverId : undefined;
  if (n.type === "dm") {
    return n.actorName ? `/dm/${n.actorName}` : null;
  }
  if (n.type === "task_assigned" && typeof meta.channelName === "string" && meta.channelName) {
    return serverId ? tasksPath(serverId, meta.channelName) : `/tasks/${meta.channelName}`;
  }
  let channelName = typeof meta.channelName === "string" && meta.channelName ? meta.channelName : undefined;
  if (!channelName && n.channelId) {
    channelName = channels.find((c) => c.id === n.channelId)?.name;
  }
  if (!channelName) return null;
  const suffix = n.messageId ? `#${n.messageId}` : "";
  return serverId ? `${channelPath(serverId, channelName)}${suffix}` : `/channels/${channelName}${suffix}`;
}
