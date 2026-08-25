<script setup lang="ts">
import { computed } from "vue";
import { useAgentStore } from "../../stores";

const props = defineProps<{ channelName: string; agentName?: string }>();
const agentStore = useAgentStore();

const progress = computed(() => {
  if (props.agentName) {
    const byAgent = agentStore.progressByAgent[props.agentName];
    if (byAgent) return { agentName: props.agentName, headline: byAgent.headline };
  }
  const key = (props.channelName || "").replace(/^#/, "");
  return agentStore.progressByChannel[key] ?? agentStore.progressByChannel[props.channelName];
});
</script>

<template>
  <div
    v-if="progress"
    class="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-4 py-1.5 text-xs text-blue-800 dark:border-blue-900/40 dark:bg-blue-950/40 dark:text-blue-200"
  >
    <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" />
    <span class="font-medium">@{{ progress.agentName }}</span>
    <span class="min-w-0 truncate">正在{{ progress.headline }}…</span>
  </div>
</template>
