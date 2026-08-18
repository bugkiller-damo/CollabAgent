<script setup lang="ts">
import { onErrorCaptured, ref } from "vue";

// Vue 没有 class 组件的 getDerivedStateFromError/componentDidCatch；
// 用 onErrorCaptured 捕获后代组件错误（返回 false 阻止继续向上传播，对齐 React 边界的"捕获即止"语义）。
// 注意：与 React 不同，Vue 的 errorCaptured 也会捕获后代模板事件处理器里抛出的同步错误（React 边界不捕获事件处理器错误）。
const hasError = ref(false);
const errorMessage = ref("");

onErrorCaptured((err: unknown, _instance, info: string) => {
  hasError.value = true;
  errorMessage.value = err instanceof Error ? err.message : String(err);
  console.error("[ErrorBoundary] Caught:", err, info);
  return false;
});

// 重试：卸载 fallback、重新挂载 slot 子树（等价于 React 重置 hasError 后子树重新渲染）
function retry() {
  hasError.value = false;
  errorMessage.value = "";
}

function reload() {
  window.location.reload();
}

// slot 子树可能有多个根节点，丢弃 fallthrough 属性以避免 Vue 警告
defineOptions({ inheritAttrs: false });
</script>

<template>
  <div
    v-if="hasError"
    class="flex flex-col items-center justify-center h-full py-16 px-4 text-center bg-gray-50 dark:bg-gray-900"
  >
    <div class="text-5xl mb-4">⚠️</div>
    <h2 class="text-gray-800 dark:text-white font-bold text-lg mb-2">页面遇到问题</h2>
    <p class="text-gray-500 dark:text-gray-400 text-sm max-w-md mb-1">{{ errorMessage || "未知错误" }}</p>
    <p class="text-gray-400 dark:text-gray-600 text-xs mb-4">刷新或点击下方按钮重试</p>
    <div class="flex gap-2">
      <button class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-500 text-sm" @click="retry">重试</button>
      <button class="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-500 text-sm" @click="reload">刷新页面</button>
    </div>
  </div>
  <slot v-else />
</template>
