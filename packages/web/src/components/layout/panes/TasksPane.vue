<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet } from "../../../api";
import { useChannelStore, useUiStore } from "../../../stores";
import SidebarSection from "../SidebarSection.vue";

interface Task {
  task_status: string;
}

const route = useRoute();
const router = useRouter();
const channelStore = useChannelStore();
const uiStore = useUiStore();

const channels = computed(() => channelStore.channels);
const activeFromRoute = computed(() => {
  const p = route.params.channelName;
  if (typeof p === "string" && route.path.startsWith("/tasks")) return p;
  return channelStore.activeChannelName || channels.value[0]?.name || "";
});

const counts = ref<Record<string, { todo: number; in_progress: number }>>({});

async function loadCounts(name: string) {
  if (!name) return;
  try {
    const d = await apiGet<{ tasks: Task[] }>("/api/tasks", { channel: "#" + name });
    const tasks = d.tasks || [];
    counts.value = {
      ...counts.value,
      [name]: {
        todo: tasks.filter((t) => t.task_status === "todo").length,
        in_progress: tasks.filter((t) => t.task_status === "in_progress").length,
      },
    };
  } catch {
    /* ignore */
  }
}

watch(activeFromRoute, (name) => loadCounts(name), { immediate: true });

function openChannel(name: string) {
  uiStore.closeMobileDrawer();
  void router.push("/tasks/" + encodeURIComponent(name));
}

const summary = computed(() => counts.value[activeFromRoute.value]);
</script>

<template>
  <div class="flex h-full flex-col p-2">
    <div v-if="activeFromRoute" class="mb-3 rounded-md bg-white px-3 py-2 text-xs dark:bg-gray-700">
      <p class="font-medium text-gray-900 dark:text-white">当前：#{{ activeFromRoute }}</p>
      <p class="mt-0.5 text-gray-500">
        待办 {{ summary?.todo ?? "…" }} · 进行中 {{ summary?.in_progress ?? "…" }}
      </p>
    </div>
    <SidebarSection title="频道" persist-key="tasks.channels" :count="channels.length">
      <button
        v-for="ch in channels"
        :key="ch.id"
        :class="[
          'flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm',
          ch.name === activeFromRoute
            ? 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-700 dark:text-white'
            : 'text-gray-600 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700',
        ]"
        @click="openChannel(ch.name)"
      >
        <span class="mr-2 text-gray-400">#</span>
        <span class="truncate">{{ ch.name }}</span>
      </button>
      <p v-if="channels.length === 0" class="px-2 py-4 text-xs text-gray-400">暂无频道</p>
    </SidebarSection>
  </div>
</template>
