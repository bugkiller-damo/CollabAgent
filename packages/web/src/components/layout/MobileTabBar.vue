<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type SidebarPane, useChannelStore, useNotificationStore, useUiStore } from "../../stores";

const route = useRoute();
const router = useRouter();
const uiStore = useUiStore();
const channelStore = useChannelStore();
const notificationStore = useNotificationStore();

const tabs: { id: SidebarPane | "tasks-page"; label: string; d: string }[] = [
  {
    id: "chat",
    label: "聊天",
    d: "M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3.75-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155",
  },
  {
    id: "activity",
    label: "动态",
    d: "m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z",
  },
  {
    id: "tasks-page",
    label: "任务",
    d: "M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z",
  },
  {
    id: "people",
    label: "成员",
    d: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.295-2.228-.837-3.244M15 19.128c.956.6 2.04.872 3.124.872M7.5 14.251c.956.6 2.04.872 3.124.872 1.085 0 2.169-.273 3.124-.872M7.5 14.251c.63.394 1.343.6 2.076.6h.017c.734 0 1.446-.206 2.076-.6m-4.17-.6a4.125 4.125 0 0 1-7.532 2.493 9.337 9.337 0 0 1 4.121-.952 9.38 9.38 0 0 1 2.625.372",
  },
];

function isActive(id: string): boolean {
  if (id === "tasks-page") return route.path.startsWith("/tasks");
  if (id === "chat") return route.path.startsWith("/channels") || route.path.startsWith("/dm");
  if (id === "people") {
    return route.path === "/people" || route.path.startsWith("/admin") || route.path.startsWith("/computers");
  }
  if (id === "activity") return route.path === "/activity";
  return false;
}

function badge(id: string): number {
  if (id === "activity") return notificationStore.unreadCount;
  if (id === "chat") return Object.values(channelStore.unreadCounts).reduce((s, n) => s + (n || 0), 0);
  return 0;
}

function onTab(id: string) {
  uiStore.closeMobileDrawer();
  if (id === "tasks-page") {
    const ch = channelStore.activeChannelName;
    void router.push(ch ? `/tasks/${encodeURIComponent(ch)}` : "/tasks");
    return;
  }
  if (id === "chat") {
    const ch = channelStore.activeChannelName;
    void router.push(ch ? `/channels/${encodeURIComponent(ch)}` : "/channels/general");
    return;
  }
  if (id === "activity") {
    void router.push("/activity");
    return;
  }
  if (id === "people") {
    void router.push("/people");
    return;
  }
  uiStore.openMobileDrawer(id as SidebarPane);
}
</script>

<template>
  <nav class="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white px-2 pb-safe lg:hidden dark:border-gray-700 dark:bg-gray-800">
    <div class="flex items-center justify-around">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        :class="[
          'relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors',
          isActive(t.id) ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400',
        ]"
        @click="onTab(t.id)"
      >
        <svg :class="['h-5 w-5', isActive(t.id) ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" :d="t.d" />
        </svg>
        {{ t.label }}
        <span
          v-if="badge(t.id) > 0"
          class="absolute right-[22%] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] text-white"
        >
          {{ badge(t.id) > 99 ? "99+" : badge(t.id) }}
        </span>
      </button>
    </div>
  </nav>
</template>
