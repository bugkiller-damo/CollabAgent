<script setup lang="ts">
import { Check, ChevronDown, Circle, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiGet } from "../api";
import { LG_QUERY, useMediaQuery, usePolling } from "../composables";
import { claudeInstalled, type RuntimeProbe } from "../stores/computerStore";

const DISMISS_KEY = "onboarding_dismissed";
const COLLAPSED_KEY = "slock.onboarding.collapsed";

interface Step {
  label: string;
  done: boolean;
  to: string;
  cta: string;
}

const dismissed = ref(localStorage.getItem(DISMISS_KEY) === "1");
// 折叠态：无存储值时桌面展开、窄屏折叠（挂载时读一次，不跟随 resize 翻转用户选择）
const isDesktop = useMediaQuery(LG_QUERY);
const collapsed = ref(
  (() => {
    const v = localStorage.getItem(COLLAPSED_KEY);
    return v === null ? !isDesktop.value : v === "1";
  })(),
);
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
  { label: "邀请同事加入（可选）", done: false, to: "/people", cta: "去邀请" },
]);

const show = computed(() => {
  if (dismissed.value) return false;
  if (daemonOn.value === null || hasAgent.value === null || claudeOn.value === null) return false;
  return !(steps.value[0].done && steps.value[1].done);
});

const next = computed(() => steps.value.find((s) => !s.done) || steps.value[0]);
const doneCount = computed(() => steps.value.filter((s) => s.done).length);

function setCollapsed(v: boolean) {
  collapsed.value = v;
  localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
}

function dismiss() {
  localStorage.setItem(DISMISS_KEY, "1");
  dismissed.value = true;
}
</script>

<template>
  <!-- 位置：bottom 抬到移动 tab bar + 输入框之上（lg 以上只需避开输入框）；z-20 让模态/抽屉正常盖住它 -->
  <button
    v-if="show && collapsed"
    type="button"
    class="fixed right-4 bottom-[calc(11rem+env(safe-area-inset-bottom))] lg:bottom-28 z-20 flex items-center gap-1.5 rounded-full bg-surface border border-line shadow-lg px-3.5 py-2 text-xs font-medium text-ink hover:bg-gray-50 dark:hover:bg-gray-700"
    @click="setCollapsed(false)"
  >
    快速开始 · {{ doneCount }}/{{ steps.length }}
  </button>
  <div
    v-else-if="show"
    class="fixed right-4 bottom-[calc(11rem+env(safe-area-inset-bottom))] lg:bottom-28 z-20 w-72 max-w-[calc(100vw-2rem)] bg-surface rounded-lg shadow-xl border border-line p-4"
  >
    <div class="flex items-start justify-between mb-2">
      <h3 class="text-ink text-sm font-semibold">快速开始</h3>
      <div class="flex items-center gap-1">
        <button class="text-muted hover:text-gray-600 dark:hover:text-gray-200 text-sm" title="收起" @click="setCollapsed(true)">
          <ChevronDown class="h-4 w-4" />
        </button>
        <button class="text-muted hover:text-gray-600 dark:hover:text-gray-200 text-sm" title="不再显示" @click="dismiss">
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
    <ul class="space-y-2">
      <li v-for="s in steps" :key="s.label" class="flex items-center gap-2 text-sm">
        <span :class="s.done ? 'text-green-500' : 'text-muted'">
          <Check v-if="s.done" class="h-3.5 w-3.5" />
          <Circle v-else class="h-3 w-3" />
        </span>
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
