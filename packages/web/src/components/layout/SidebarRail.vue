<script setup lang="ts">
import { computed } from "vue";
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

const items: { id: SidebarPane; label: string; d: string }[] = [
  {
    id: "search",
    label: "搜索",
    d: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
  },
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
    id: "tasks",
    label: "任务",
    d: "M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25Z",
  },
  {
    id: "people",
    label: "成员",
    d: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.295-2.228-.837-3.244M15 19.128c.956.6 2.04.872 3.124.872M7.5 14.251c.956.6 2.04.872 3.124.872 1.085 0 2.169-.273 3.124-.872M7.5 14.251c.63.394 1.343.6 2.076.6h.017c.734 0 1.446-.206 2.076-.6m-4.17-.6a4.125 4.125 0 0 1-7.532 2.493 9.337 9.337 0 0 1 4.121-.952 9.38 9.38 0 0 1 2.625.372m0 0V5.337",
  },
  {
    id: "computers",
    label: "计算机",
    d: "M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25A2.25 2.25 0 0 1 5.25 3h13.5A2.25 2.25 0 0 1 21 5.25Z",
  },
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
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" :d="item.d" />
          </svg>
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
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
            />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </button>
      </Tooltip>
      <UserMenu compact />
    </div>
  </nav>
</template>
