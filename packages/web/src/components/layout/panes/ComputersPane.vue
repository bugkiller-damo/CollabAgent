<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useComputerStore, useUiStore } from "../../../stores";

const router = useRouter();
const uiStore = useUiStore();
const computerStore = useComputerStore();

onMounted(() => {
  void computerStore.refresh();
});

function goComputers() {
  uiStore.closeMobileDrawer();
  void router.push("/computers");
}
</script>

<template>
  <div class="flex h-full flex-col">
    <nav class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
      <button
        v-if="computerStore.computer"
        type="button"
        :class="[
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
          'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700',
        ]"
        @click="goComputers"
      >
        <span
          :class="['h-2 w-2 shrink-0 rounded-full', computerStore.connected ? 'bg-green-500' : 'bg-gray-400']"
        />
        <span class="min-w-0 flex-1 truncate">{{ computerStore.computer.name }}</span>
        <span class="shrink-0 text-[10px] text-gray-400">{{ computerStore.connected ? "在线" : "离线" }}</span>
      </button>
      <button
        v-else
        type="button"
        class="w-full rounded-md px-2 py-2 text-left text-sm text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/30"
        @click="goComputers"
      >
        连接我的计算机
      </button>
    </nav>
  </div>
</template>
