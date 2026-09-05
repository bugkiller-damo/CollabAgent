<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiGet } from "../api";
import { usePolling } from "../composables";
import { claudeInstalled, type RuntimeProbe } from "../stores/computerStore";

const DISMISS_KEY = "onboarding_dismissed";

interface Step {
  label: string;
  done: boolean;
  to: string;
  cta: string;
}

const dismissed = ref(localStorage.getItem(DISMISS_KEY) === "1");
const daemonOn = ref<boolean | null>(null);
const claudeOn = ref<boolean | null>(null);
const hasAgent = ref<boolean | null>(null);

function load() {
  if (dismissed.value) return;
  apiGet<{ connected: boolean; runtimes?: RuntimeProbe[] }>("/api/daemon/status")
    .then((d) => {
      daemonOn.value = !!d.connected;
      claudeOn.value = !!d.connected && claudeInstalled(d.runtimes || []);
    })
    .catch(() => {
      daemonOn.value = false;
      claudeOn.value = false;
    });
  apiGet<{ agents: any[] }>("/api/agents")
    .then((d) => {
      hasAgent.value = (d.agents || []).length > 0;
    })
    .catch(() => {
      hasAgent.value = false;
    });
}

onMounted(() => {
  load();
});
usePolling(load, 8000);

const steps = computed<Step[]>(() => [
  {
    label: "连接我的计算机",
    done: !!daemonOn.value && !!claudeOn.value,
    to: "/computers",
    cta: daemonOn.value && !claudeOn.value ? "去安装 Claude" : "去连接",
  },
  { label: "创建第一个 Agent", done: !!hasAgent.value, to: "/computers", cta: "去创建" },
  { label: "邀请同事加入（可选）", done: false, to: "/admin/members", cta: "去邀请" },
]);

const show = computed(() => {
  if (dismissed.value) return false;
  if (daemonOn.value === null || hasAgent.value === null || claudeOn.value === null) return false;
  return !(steps.value[0].done && steps.value[1].done);
});

const next = computed(() => steps.value.find((s) => !s.done) || steps.value[0]);

function dismiss() {
  localStorage.setItem(DISMISS_KEY, "1");
  dismissed.value = true;
}
</script>

<template>
  <div
    v-if="show"
    class="fixed bottom-4 right-4 z-50 w-72 bg-surface rounded-lg shadow-xl border border-line p-4"
  >
    <div class="flex items-start justify-between mb-2">
      <h3 class="text-ink text-sm font-semibold">快速开始</h3>
      <button class="text-muted hover:text-gray-600 dark:hover:text-gray-200 text-sm" title="不再显示" @click="dismiss">✕</button>
    </div>
    <ul class="space-y-2">
      <li v-for="s in steps" :key="s.label" class="flex items-center gap-2 text-sm">
        <span :class="s.done ? 'text-green-500' : 'text-muted'">{{ s.done ? "✓" : "○" }}</span>
        <span :class="s.done ? 'text-muted line-through' : 'text-gray-700 dark:text-gray-200'">{{ s.label }}</span>
      </li>
    </ul>
    <p v-if="daemonOn && !claudeOn" class="mt-2 text-xs text-amber-600 dark:text-amber-400">
      计算机已连上，但还没装 Claude Code。
    </p>
    <RouterLink
      :to="next.to"
      class="mt-3 block text-center bg-blue-600 text-white text-sm py-2 rounded hover:bg-blue-500"
    >
      {{ next.cta }}
    </RouterLink>
  </div>
</template>
