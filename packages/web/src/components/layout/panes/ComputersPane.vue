<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useComputerStore, useServerStore, useUiStore } from "../../../stores";

const router = useRouter();
const uiStore = useUiStore();
const computerStore = useComputerStore();
const serverStore = useServerStore();

const myComputers = computed(() => computerStore.myComputers);
const otherCount = computed(() => computerStore.computers.length - myComputers.value.length);

onMounted(() => {
  void computerStore.refresh();
});
// 列表是活跃 server 语境——切 server 即换一批机器
watch(
  () => serverStore.activeServerId,
  () => void computerStore.refresh(),
);

function goComputers() {
  uiStore.closeMobileDrawer();
  void router.push("/computers");
}

function goComputer(id: string) {
  uiStore.closeMobileDrawer();
  void router.push("/computers/" + id);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <nav class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
      <button
        v-for="c in myComputers"
        :key="c.id"
        type="button"
        :class="[
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
          'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700',
        ]"
        @click="goComputer(c.id)"
      >
        <span :class="['h-2 w-2 shrink-0 rounded-full', c.online ? 'bg-green-500' : 'bg-gray-400']" />
        <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
        <span class="shrink-0 text-[10px] text-muted">{{ c.online ? "在线" : "离线" }}</span>
      </button>

      <button
        v-if="myComputers.length === 0"
        type="button"
        class="w-full rounded-md px-2 py-2 text-left text-sm text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/30"
        @click="goComputers"
      >
        连接我的计算机
      </button>
      <button
        v-else
        type="button"
        class="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted hover:bg-gray-200 dark:hover:bg-gray-700"
        @click="goComputers"
      >
        全部计算机{{ otherCount > 0 ? `（含他人 ${otherCount} 台）` : "" }} →
      </button>
    </nav>
  </div>
</template>
