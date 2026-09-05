<script setup lang="ts">
import { type ToastKind, useToastStore } from "../stores/toastStore";

// React 版导出名为 ToastContainer（见 components/index.ts 桶文件）；模板直接读写 store 保持响应式
const toastStore = useToastStore();

// fg = 前景文字色。warning 用深字（amber-500 底压白字仅 2.3:1 不达 WCAG AA，深字约 8.6:1）
const kindStyles: Record<ToastKind, { bg: string; fg: string; icon: string; border: string }> = {
  info: { bg: "bg-blue-600", fg: "text-white", icon: "ℹ️", border: "border-blue-500" },
  success: { bg: "bg-green-600", fg: "text-white", icon: "✅", border: "border-green-500" },
  warning: { bg: "bg-amber-500", fg: "text-gray-900", icon: "⚠️", border: "border-amber-400" },
  error: { bg: "bg-red-600", fg: "text-white", icon: "❌", border: "border-red-500" },
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
        'pointer-events-auto flex items-start gap-2 px-4 py-3 rounded-lg shadow-lg max-w-md border-l-4',
        kindStyles[t.kind].bg,
        kindStyles[t.kind].fg,
        kindStyles[t.kind].border,
        t.exiting ? 'animate-fade-out' : 'animate-slide-in-right',
      ]"
    >
      <span class="text-lg shrink-0">{{ kindStyles[t.kind].icon }}</span>
      <p class="text-sm flex-1 break-words">{{ t.message }}</p>
      <button
        class="opacity-70 hover:opacity-100 shrink-0"
        aria-label="关闭"
        @click="toastStore.dismiss(t.id)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
