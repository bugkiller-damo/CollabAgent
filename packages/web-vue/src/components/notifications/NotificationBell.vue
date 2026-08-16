<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useNotificationStore, type NotificationItem } from "../../stores/notificationStore";
import { readCsrf } from "../../api";

function timeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}秒前`;
  if (d < 3600) return `${Math.floor(d / 60)}分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)}小时前`;
  return `${Math.floor(d / 86400)}天前`;
}

const TYPE_ICON: Record<string, string> = {
  "@mention": "💬",
  task_assigned: "✅",
  dm: "📨",
  reminder: "⏰",
};

const notificationStore = useNotificationStore();
const router = useRouter();

const open = ref(false);
const panelRef = ref<HTMLDivElement | null>(null);

onMounted(() => {
  notificationStore.loadFromApi();
  document.addEventListener("mousedown", onClickOutside);
});
onUnmounted(() => document.removeEventListener("mousedown", onClickOutside));

function onClickOutside(e: MouseEvent) {
  if (open.value && panelRef.value && !panelRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

async function handleClick(n: NotificationItem) {
  if (!n.read) {
    notificationStore.markAsRead(n.id);
    try {
      await fetch(`/api/notifications/${n.id}/read`, {
        method: "PATCH",
        credentials: "include",
        headers: { "X-CSRF-Token": readCsrf() || "" },
      });
    } catch { /* ignore */ }
  }
  if (n.channelId) {
    const meta = n.metadata || {};
    const channelName = meta.channelName;
    open.value = false;
    if (channelName) {
      router.push(`/channels/${channelName}`);
    }
  }
}

async function handleMarkAll() {
  notificationStore.markAllAsRead();
  try {
    await fetch("/api/notifications/read", {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": readCsrf() || "",
      },
    });
  } catch { /* ignore */ }
}
</script>

<template>
  <div ref="panelRef" class="relative">
    <button
      class="relative p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition"
      title="通知"
      aria-label="通知"
      @click="open = !open"
    >
      <span class="text-xl">🔔</span>
      <span
        v-if="notificationStore.unreadCount > 0"
        class="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1"
      >
        {{ notificationStore.unreadCount > 99 ? "99+" : notificationStore.unreadCount }}
      </span>
    </button>
    <div
      v-if="open"
      class="absolute right-0 top-full mt-2 w-96 max-h-[480px] bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden flex flex-col"
    >
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 class="font-semibold text-gray-900 dark:text-gray-100">通知</h3>
        <button
          v-if="notificationStore.unreadCount > 0"
          class="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
          @click="handleMarkAll"
        >
          全部已读
        </button>
      </div>
      <div class="overflow-y-auto flex-1">
        <div
          v-if="notificationStore.loading && notificationStore.notifications.length === 0"
          class="px-4 py-8 text-center text-gray-500 dark:text-gray-400 text-sm"
        >
          加载中…
        </div>
        <div
          v-else-if="notificationStore.notifications.length === 0"
          class="px-4 py-8 text-center text-gray-500 dark:text-gray-400 text-sm"
        >
          暂无通知
        </div>
        <template v-else>
          <button
            v-for="n in notificationStore.notifications"
            :key="n.id"
            :class="[
              'w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition flex gap-3',
              !n.read ? 'bg-blue-50 dark:bg-blue-900/20' : '',
            ]"
            @click="handleClick(n)"
          >
            <span class="text-2xl flex-shrink-0">{{ TYPE_ICON[n.type] || "📌" }}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-start justify-between gap-2">
                <p class="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">{{ n.title }}</p>
                <span v-if="!n.read" class="w-2 h-2 rounded-full bg-blue-500 mt-1 flex-shrink-0" />
              </div>
              <p v-if="n.body" class="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">{{ n.body }}</p>
              <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">{{ timeAgo(n.createdAt) }}</p>
            </div>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
