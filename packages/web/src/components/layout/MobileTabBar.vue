<script setup lang="ts">
import { MessageCircle, ShieldCheck, Users, Zap } from "@lucide/vue";
import { type Component, computed, markRaw } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type SidebarPane, useChannelStore, useNotificationStore, useUiStore } from "../../stores";

const route = useRoute();
const router = useRouter();
const uiStore = useUiStore();
const channelStore = useChannelStore();
const notificationStore = useNotificationStore();

const tabs: { id: SidebarPane | "tasks-page"; label: string; icon: Component }[] = [
  { id: "chat", label: "聊天", icon: markRaw(MessageCircle) },
  { id: "activity", label: "动态", icon: markRaw(Zap) },
  { id: "tasks-page", label: "任务", icon: markRaw(ShieldCheck) },
  { id: "people", label: "成员", icon: markRaw(Users) },
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
          isActive(t.id) ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-muted',
        ]"
        @click="onTab(t.id)"
      >
        <component :is="t.icon" :class="['h-5 w-5', isActive(t.id) ? 'text-blue-500' : 'text-muted']" />
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
