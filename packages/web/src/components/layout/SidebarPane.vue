<script setup lang="ts">
import { computed } from "vue";
import { useUiStore } from "../../stores";

const TITLES: Record<string, string> = {
  search: "搜索",
  chat: "聊天",
  activity: "动态",
  tasks: "任务",
  people: "成员",
  computers: "计算机",
};

const uiStore = useUiStore();
const title = computed(() => TITLES[uiStore.sidebarPane] || "");
</script>

<template>
  <aside
    class="flex h-full w-60 shrink-0 flex-col border-r border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800"
  >
    <div class="hidden h-12 shrink-0 items-center border-b border-gray-200 px-3 lg:flex dark:border-gray-700">
      <h2 class="truncate text-sm font-semibold text-gray-900 dark:text-white">{{ title }}</h2>
      <slot name="header-extra" />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <slot />
    </div>
    <slot name="footer" />
  </aside>
</template>
