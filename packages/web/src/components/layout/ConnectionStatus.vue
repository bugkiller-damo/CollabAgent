<script setup lang="ts">
import { computed } from "vue";
import { useUiStore } from "../../stores";

const uiStore = useUiStore();

const CONFIG: Record<string, { dot: string; text: string; pulse?: boolean }> = {
  connected: { dot: "bg-green-500", text: "已连接" },
  connecting: { dot: "bg-yellow-500", text: "连接中…", pulse: true },
  reconnecting: { dot: "bg-yellow-500", text: "重连中…", pulse: true },
  disconnected: { dot: "bg-red-500", text: "已断开" },
};

const status = computed(() => uiStore.wsStatus);
const attempt = computed(() => uiStore.wsReconnectAttempt);
const online = computed(() => uiStore.online);
const cfg = computed(() => CONFIG[status.value] || CONFIG.disconnected);

// 连续重连多次仍失败 → 给出诊断提示
const diagnostic = computed(() => {
  if (status.value === "connected") return null;
  if (attempt.value < 2 && status.value !== "disconnected") return null;
  return !online.value ? "网络已断开，请检查本地网络" : "无法连接到服务器，请确认后端服务是否运行";
});
</script>

<template>
  <div class="px-3 py-1.5 text-xs text-muted">
    <div class="flex items-center gap-2">
      <span :class="['w-2 h-2 rounded-full shrink-0', cfg.dot, cfg.pulse ? 'animate-pulse' : '']" />
      <span class="truncate">
        {{ cfg.text }}
        <span v-if="status === 'reconnecting' && attempt > 0" class="text-gray-400">（第 {{ attempt }} 次）</span>
      </span>
    </div>
    <div v-if="diagnostic" class="text-[11px] text-amber-500 mt-0.5 pl-4">{{ diagnostic }}</div>
  </div>
</template>
