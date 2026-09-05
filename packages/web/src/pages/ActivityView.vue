<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { readCsrf } from "../api";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import { useUiStore } from "../stores";
import { type NotificationItem, useNotificationStore } from "../stores/notificationStore";

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
const uiStore = useUiStore();
const router = useRouter();
const filter = ref<"all" | "unread">("all");

const list = computed(() => {
  const all = notificationStore.notifications;
  return filter.value === "unread" ? all.filter((n) => !n.read) : all;
});

onMounted(() => {
  notificationStore.loadFromApi();
});

async function handleClick(n: NotificationItem) {
  if (!n.read) {
    notificationStore.markAsRead(n.id);
    try {
      await fetch(`/api/notifications/${n.id}/read`, {
        method: "PATCH",
        credentials: "include",
        headers: { "X-CSRF-Token": readCsrf() || "" },
      });
    } catch {
      /* ignore */
    }
  }
  const channelName = n.metadata?.channelName;
  if (channelName) {
    uiStore.openSidebarPane("chat");
    uiStore.closeMobileDrawer();
    void router.push(`/channels/${channelName}`);
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
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader title="动态" subtitle="提及、任务与提醒">
      <div class="flex items-center gap-2">
        <div class="flex gap-1">
          <button
            type="button"
            :class="[
              'rounded-md px-2 py-1 text-xs',
              filter === 'all' ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white' : 'text-gray-500',
            ]"
            @click="filter = 'all'"
          >
            全部
          </button>
          <button
            type="button"
            :class="[
              'rounded-md px-2 py-1 text-xs',
              filter === 'unread' ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white' : 'text-gray-500',
            ]"
            @click="filter = 'unread'"
          >
            未读
          </button>
        </div>
        <button
          v-if="notificationStore.unreadCount > 0"
          type="button"
          class="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
          @click="handleMarkAll"
        >
          全部已读
        </button>
      </div>
    </PageHeader>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div
        v-if="notificationStore.loading && notificationStore.notifications.length === 0"
        class="px-4 py-8 text-center text-sm text-gray-500"
      >
        加载中…
      </div>
      <EmptyState v-else-if="list.length === 0" icon="⚡" title="暂无动态" description="提及、任务指派和提醒会显示在这里" />
      <button
        v-for="n in list"
        :key="n.id"
        type="button"
        :class="[
          'flex w-full gap-3 border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-800/60',
          !n.read ? 'bg-blue-50 dark:bg-blue-900/20' : '',
        ]"
        @click="handleClick(n)"
      >
        <span class="shrink-0 text-lg">{{ TYPE_ICON[n.type] || "📌" }}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <p class="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{{ n.title }}</p>
            <span v-if="!n.read" class="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-500" />
          </div>
          <p v-if="n.body" class="mt-0.5 line-clamp-2 text-sm text-subtle">{{ n.body }}</p>
          <p class="mt-1 text-xs text-muted">{{ timeAgo(n.createdAt) }}</p>
        </div>
      </button>
    </div>
  </div>
</template>
