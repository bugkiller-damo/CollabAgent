import { ref } from "vue";
import { defineStore } from "pinia";

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
    notifications.value = notifications.value.map((x) => x.id === id ? { ...x, read: true } : x);
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
      notifications.value = data.notifications || [];
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
