<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiGet } from "../../api";
import { useAgentStore, useUiStore } from "../../stores";
import Avatar from "../ui/Avatar.vue";

interface Agent {
  id: string;
  name: string;
  display_name: string;
  isOnline: boolean;
  avatar_url?: string;
}

const LIVE_STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  working: { text: "工作中", cls: "text-blue-500" },
  starting: { text: "启动中", cls: "text-amber-500" },
  idle: { text: "空闲", cls: "text-green-500" },
  offline: { text: "离线", cls: "text-gray-400" },
  stopped: { text: "已停止", cls: "text-gray-400" },
};

const uiStore = useUiStore();
const agentStore = useAgentStore();

const agents = ref<Agent[]>([]);
const loaded = ref(false);

onMounted(() => {
  apiGet<{ agents: Agent[] }>("/api/agents")
    .then((d) => {
      agents.value = (d.agents || []).slice(0, 5);
      loaded.value = true;
    })
    .catch(() => {
      loaded.value = true;
    });
});

const liveAgents = computed(() => agentStore.agents);
const terminalAgent = computed(() => uiStore.terminalAgent);

function statusFor(a: Agent): { text: string; cls: string } {
  const live = liveAgents.value[a.name];
  const statusKey = live?.status && live.status !== "online" ? live.status : a.isOnline ? "idle" : "offline";
  return LIVE_STATUS_LABEL[statusKey] || LIVE_STATUS_LABEL.offline;
}

function openTerminal(name: string) {
  uiStore.openTerminal(terminalAgent.value === name ? null : name);
}
</script>

<template>
  <div v-if="loaded" class="border-t border-gray-200 p-2 dark:border-gray-700">
    <div class="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
      Agent 状态
    </div>
    <div v-if="agents.length === 0" class="px-2 py-1.5 text-xs text-gray-400 dark:text-gray-500">
      暂无 Agent，去「接入 Agent」创建一个
    </div>
    <template v-else>
      <button
      v-for="a in agents"
      :key="a.id"
      :title="'观察终端'"
      :class="[
        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
        terminalAgent === a.name
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          : 'hover:bg-gray-200 dark:hover:bg-gray-700',
      ]"
      @click="openTerminal(a.name)"
    >
      <div :class="['h-2 w-2 shrink-0 rounded-full', a.isOnline ? 'bg-green-500' : 'bg-gray-500']" />
      <Avatar :name="a.display_name || a.name" :src="a.avatar_url" size="sm" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1">
          <span class="truncate text-gray-600 dark:text-gray-300">@{{ a.name }}</span>
          <span :class="['ml-auto shrink-0 text-[10px]', statusFor(a).cls]">{{ statusFor(a).text }}</span>
        </div>
        <p
          v-if="liveAgents[a.name]?.detail"
          class="truncate text-[10px] text-gray-400 dark:text-gray-500"
          :title="liveAgents[a.name].detail"
        >
          {{ liveAgents[a.name].detail }}
        </p>
      </div>
    </button>
    </template>
  </div>
</template>
