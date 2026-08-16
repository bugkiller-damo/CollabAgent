import { create } from "zustand";

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

interface NotificationState {
  notifications: NotificationItem[];
  unreadCount: number;
  hasMore: boolean;
  loading: boolean;
  setNotifications: (list: NotificationItem[]) => void;
  setUnreadCount: (count: number) => void;
  prependNotification: (n: NotificationItem) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  refresh: () => Promise<void>;
  loadFromApi: () => Promise<void>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  hasMore: false,
  loading: false,

  setNotifications: (list) => set({ notifications: list }),
  setUnreadCount: (count) => set({ unreadCount: count }),

  prependNotification: (n) =>
    set((s) => ({
      notifications: [n, ...s.notifications],
      unreadCount: s.unreadCount + (n.read ? 0 : 1),
    })),

  markAsRead: (id) =>
    set((s) => {
      const target = s.notifications.find((x) => x.id === id);
      if (!target || target.read) return {};
      return {
        notifications: s.notifications.map((x) => (x.id === id ? { ...x, read: true } : x)),
        unreadCount: Math.max(0, s.unreadCount - 1),
      };
    }),

  markAllAsRead: () =>
    set((s) => ({
      notifications: s.notifications.map((x) => ({ ...x, read: true })),
      unreadCount: 0,
    })),

  loadFromApi: async () => {
    set({ loading: true });
    try {
      const res = await fetch("/api/notifications?limit=50", { credentials: "include" });
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      const data = await res.json();
      set({
        notifications: data.notifications || [],
        unreadCount: data.unreadCount || 0,
        hasMore: data.hasMore || false,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  refresh: async () => {
    await get().loadFromApi();
  },
}));
