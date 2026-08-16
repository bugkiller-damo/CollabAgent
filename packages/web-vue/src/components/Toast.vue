<script setup lang="ts">
import { useToastStore, type ToastKind } from "../stores/toastStore";

// React 版导出名为 ToastContainer（见 components/index.ts 桶文件）；模板直接读写 store 保持响应式
const toastStore = useToastStore();

const kindStyles: Record<ToastKind, { bg: string; icon: string; border: string }> = {
  info: { bg: "bg-blue-600", icon: "ℹ️", border: "border-blue-500" },
  success: { bg: "bg-emerald-600", icon: "✅", border: "border-emerald-500" },
  warning: { bg: "bg-amber-500", icon: "⚠️", border: "border-amber-400" },
  error: { bg: "bg-red-600", icon: "❌", border: "border-red-500" },
};
</script>

<template>
  <div
    v-if="toastStore.toasts.length > 0"
    class="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
    role="status"
    aria-live="polite"
  >
    <div
      v-for="(t, idx) in toastStore.toasts"
      :key="t.id"
      :style="t.exiting ? undefined : { animationDelay: `${idx * 60}ms` }"
      :class="[
        'pointer-events-auto flex items-start gap-2 text-white px-4 py-3 rounded-lg shadow-lg max-w-md border-l-4',
        kindStyles[t.kind].bg,
        kindStyles[t.kind].border,
        t.exiting ? 'animate-fade-out' : 'animate-slide-in-right',
      ]"
    >
      <span class="text-lg shrink-0">{{ kindStyles[t.kind].icon }}</span>
      <p class="text-sm flex-1 break-words">{{ t.message }}</p>
      <button
        class="text-white/70 hover:text-white shrink-0"
        aria-label="关闭"
        @click="toastStore.dismiss(t.id)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
