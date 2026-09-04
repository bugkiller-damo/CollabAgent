<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { hasSidebarDetailPane, useUiStore } from "../../stores";
import ChatPane from "./panes/ChatPane.vue";
import ComputersPane from "./panes/ComputersPane.vue";
import TasksPane from "./panes/TasksPane.vue";
import SidebarPane from "./SidebarPane.vue";
import SidebarRail from "./SidebarRail.vue";
import UserMenu from "./UserMenu.vue";

const uiStore = useUiStore();
const router = useRouter();

const showPane = computed(
  () => hasSidebarDetailPane(uiStore.sidebarPane) && (uiStore.sidebarOpen || uiStore.mobileDrawerOpen),
);

function goSearch() {
  uiStore.closeMobileDrawer();
  void router.push("/search");
}
</script>

<template>
  <div class="flex h-full">
    <SidebarRail />
    <div
      :class="[
        'flex h-full flex-col overflow-hidden transition-[width] duration-200 ease-in-out',
        showPane ? 'w-60' : 'w-0',
      ]"
    >
      <div class="flex h-12 w-60 shrink-0 items-center gap-2 border-b border-gray-200 bg-gray-100 px-2 lg:hidden dark:border-gray-700 dark:bg-gray-800">
        <div class="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 text-xs font-bold text-white">C</div>
        <span class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">CollabAgent</span>
        <button
          type="button"
          class="rounded-md p-1.5 text-gray-500 hover:bg-raised"
          aria-label="搜索"
          @click="goSearch"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
        </button>
        <UserMenu compact />
      </div>
      <div class="min-h-0 w-60 flex-1">
        <SidebarPane>
          <ChatPane v-if="uiStore.sidebarPane === 'chat'" />
          <TasksPane v-else-if="uiStore.sidebarPane === 'tasks'" />
          <ComputersPane v-else-if="uiStore.sidebarPane === 'computers'" />
        </SidebarPane>
      </div>
    </div>
  </div>
</template>
