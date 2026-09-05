<script setup lang="ts">
import { ClipboardList, MessageCircle, Monitor, Search, Settings, Users, Zap } from "@lucide/vue";
import { type Component, computed, markRaw } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type SidebarPane, useChannelStore, useComputerStore, useNotificationStore, useUiStore } from "../../stores";
import Tooltip from "../ui/Tooltip.vue";
import UserMenu from "./UserMenu.vue";

const uiStore = useUiStore();
const channelStore = useChannelStore();
const notificationStore = useNotificationStore();
const computerStore = useComputerStore();
const route = useRoute();
const router = useRouter();

const chatUnread = computed(() => Object.values(channelStore.unreadCounts).reduce((sum, n) => sum + (n || 0), 0));
const activityUnread = computed(() => notificationStore.unreadCount);

const settingsActive = computed(() => route.path.startsWith("/settings"));

const items: { id: SidebarPane; label: string; icon: Component }[] = [
  { id: "search", label: "搜索", icon: markRaw(Search) },
  { id: "chat", label: "聊天", icon: markRaw(MessageCircle) },
  { id: "activity", label: "动态", icon: markRaw(Zap) },
  { id: "tasks", label: "任务", icon: markRaw(ClipboardList) },
  { id: "people", label: "成员", icon: markRaw(Users) },
  { id: "computers", label: "计算机", icon: markRaw(Monitor) },
];

function badgeFor(id: SidebarPane): number {
  if (id === "chat") return chatUnread.value;
  if (id === "activity") return activityUnread.value;
  return 0;
}

function lastChatPath(): string {
  const ch = channelStore.activeChannelName;
  if (ch) return `/channels/${encodeURIComponent(ch)}`;
  return "/channels/general";
}

function lastTasksPath(): string {
  const ch = channelStore.activeChannelName;
  return ch ? `/tasks/${encodeURIComponent(ch)}` : "/tasks";
}

function pathForPane(id: SidebarPane): string | null {
  if (id === "chat") return lastChatPath();
  if (id === "activity") return "/activity";
  if (id === "tasks") return lastTasksPath();
  if (id === "people") return "/people";
  if (id === "search") return "/search";
  if (id === "computers") return "/computers";
  return null;
}

function onSelect(id: SidebarPane) {
  const same = uiStore.sidebarPane === id && uiStore.sidebarOpen;
  uiStore.selectSidebarPane(id);
  if (same) return;
  if (id === "chat") {
    if (!route.path.startsWith("/channels/") && !route.path.startsWith("/dm/")) {
      void router.push(lastChatPath());
    }
    return;
  }
  if (id === "tasks") {
    if (!route.path.startsWith("/tasks")) void router.push(lastTasksPath());
    return;
  }
  const path = pathForPane(id);
  if (path && route.path !== path) void router.push(path);
}

function goSettings() {
  void router.push("/settings/profile");
}
</script>

<template>
  <nav
    class="hidden h-full w-14 shrink-0 flex-col items-center border-r border-gray-200 bg-gray-100 py-2 lg:flex dark:border-gray-700 dark:bg-gray-800"
    aria-label="主导航"
  >
    <Tooltip label="CollabAgent" position="right">
      <div class="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white" aria-hidden="true">
        <span class="text-sm font-bold">C</span>
      </div>
    </Tooltip>

    <div class="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
      <Tooltip v-for="item in items" :key="item.id" :label="item.label" position="right">
        <button
          type="button"
          :aria-label="item.label"
          :aria-pressed="uiStore.sidebarPane === item.id"
          :class="[
            'relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
            uiStore.sidebarPane === item.id
              ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white'
              : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white',
          ]"
          @click="onSelect(item.id)"
        >
          <component :is="item.icon" class="h-5 w-5" />
          <span
            v-if="item.id === 'computers'"
            :class="[
              'absolute right-1 top-1 h-2 w-2 rounded-full',
              computerStore.connected ? 'bg-green-500' : 'bg-gray-400',
            ]"
          />
          <span
            v-if="badgeFor(item.id) > 0"
            class="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white"
          >
            {{ badgeFor(item.id) > 99 ? "99+" : badgeFor(item.id) }}
          </span>
        </button>
      </Tooltip>
    </div>

    <div class="mt-auto flex flex-col items-center gap-1 pb-1">
      <Tooltip label="设置" position="right">
        <button
          type="button"
          aria-label="设置"
          :class="[
            'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
            settingsActive
              ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white'
              : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white',
          ]"
          @click="goSettings"
        >
          <Settings class="h-5 w-5" />
        </button>
      </Tooltip>
      <UserMenu compact />
    </div>
  </nav>
</template>
