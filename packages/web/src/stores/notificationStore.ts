import { defineStore } from "pinia";
import { ref } from "vue";

export interface NotificationItem {
  id: string;
  type: string;
  actorId: string;
  actorName: string | null;
  channelId: string | null;
  messageId: string | null;
  title: string;
  body: string | null;
  metadata: any;
  read: boolean;
  createdAt: string;
}

/**
 * W-A1：REST 行 → NotificationItem 归一。
 * server REST 原样返回蛇形列名（契约债，server 报告已立此存照归后续），
 * WS 实时推送则是 camelCase（server lib/notifications.ts）；入库前在此收口，
 * 此前 REST 项 createdAt/channelId 为 undefined → 「NaN天前」+ 点击不跳转。
 * 对 camelCase 输入兼容透传：server 日后 SELECT 别名收口后本映射无需改动。
 */
export function mapApiNotification(row: any): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    actorId: row.actorId ?? row.actor_id,
    actorName: row.actorName ?? row.actor_name ?? null,
    channelId: row.channelId ?? row.channel_id ?? null,
    messageId: row.messageId ?? row.message_id ?? null,
    title: row.title,
    body: row.body ?? null,
    metadata: row.metadata ?? null,
    read: Boolean(row.read),
    createdAt: row.createdAt ?? row.created_at,
  };
}

export const useNotificationStore = defineStore("notifications", () => {
  const notifications = ref<NotificationItem[]>([]);
  const unreadCount = ref(0);
  const hasMore = ref(false);
  const loading = ref(false);

  function setNotifications(list: NotificationItem[]): void {
    notifications.value = list;
  }

  function setUnreadCount(count: number): void {
    unreadCount.value = count;
  }

  function prependNotification(n: NotificationItem): void {
    notifications.value = [n, ...notifications.value];
    unreadCount.value = unreadCount.value + (n.read ? 0 : 1);
  }

  function markAsRead(id: string): void {
    const target = notifications.value.find((x) => x.id === id);
    if (!target || target.read) return;
    notifications.value = notifications.value.map((x) => (x.id === id ? { ...x, read: true } : x));
    unreadCount.value = Math.max(0, unreadCount.value - 1);
  }

  function markAllAsRead(): void {
    notifications.value = notifications.value.map((x) => ({ ...x, read: true }));
    unreadCount.value = 0;
  }

  async function loadFromApi(): Promise<void> {
    loading.value = true;
    try {
      const res = await fetch("/api/notifications?limit=50", { credentials: "include" });
      if (!res.ok) {
        loading.value = false;
        return;
      }
      const data = await res.json();
      notifications.value = (data.notifications || []).map(mapApiNotification);
      unreadCount.value = data.unreadCount || 0;
      hasMore.value = data.hasMore || false;
      loading.value = false;
    } catch {
      loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    await loadFromApi();
  }

  return {
    notifications,
    unreadCount,
    hasMore,
    loading,
    setNotifications,
    setUnreadCount,
    prependNotification,
    markAsRead,
    markAllAsRead,
    refresh,
    loadFromApi,
  };
});
