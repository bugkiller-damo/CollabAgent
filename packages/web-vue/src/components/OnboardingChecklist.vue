<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiGet } from "../api";
import { usePolling } from "../composables";

const DISMISS_KEY = "onboarding_dismissed";

interface Step {
  label: string;
  done: boolean;
  to: string;
  cta: string;
}

// 首登轻量引导：检测真实状态（daemon 是否连上、是否有 Agent），给出下一步清单。
// 全部完成或用户手动关闭后不再出现（localStorage 记忆）。
const dismissed = ref(localStorage.getItem(DISMISS_KEY) === "1");
const daemonOn = ref<boolean | null>(null);
const hasAgent = ref<boolean | null>(null);

function load() {
  if (dismissed.value) return;
  apiGet<{ connected: boolean }>("/api/daemon/status")
    .then((d) => {
      daemonOn.value = !!d.connected;
    })
    .catch(() => {
      daemonOn.value = false;
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
  { label: "连接本机 Claude", done: !!daemonOn.value, to: "/connect", cta: "去连接" },
  { label: "创建第一个 Agent", done: !!hasAgent.value, to: "/connect", cta: "去创建" },
  { label: "邀请同事加入（可选）", done: false, to: "/admin/members", cta: "去邀请" },
]);

// 前两个必做步骤都完成则自动隐藏
const show = computed(() => {
  if (dismissed.value) return false;
  if (daemonOn.value === null || hasAgent.value === null) return false;
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
    class="fixed bottom-4 right-4 z-50 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4"
  >
    <div class="flex items-start justify-between mb-2">
      <h3 class="text-gray-900 dark:text-white text-sm font-semibold">快速开始</h3>
      <button class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm" title="不再显示" @click="dismiss">✕</button>
    </div>
    <ul class="space-y-2">
      <li v-for="s in steps" :key="s.label" class="flex items-center gap-2 text-sm">
        <span :class="s.done ? 'text-green-500' : 'text-gray-400'">{{ s.done ? "✓" : "○" }}</span>
        <span :class="s.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'">{{ s.label }}</span>
      </li>
    </ul>
    <RouterLink
      :to="next.to"
      class="mt-3 block text-center bg-blue-600 text-white text-sm py-2 rounded hover:bg-blue-500"
    >
      {{ next.cta }}
    </RouterLink>
  </div>
</template>
