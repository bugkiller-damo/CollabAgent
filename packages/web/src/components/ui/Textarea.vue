<script setup lang="ts">
import { ref } from "vue";

// 纯样式包装：value / onInput / rows / readonly 等原生属性与父级 class 全部 fallthrough 到 textarea。
// 对齐 React 受控写法：父组件用 :value + @input（Textarea 不支持 v-model）。
const el = ref<HTMLTextAreaElement | null>(null);

function focus() {
  el.value?.focus();
}

// 对齐 React forwardRef：父组件模板 ref 上可直接访问 el（已解包为 DOM 元素，供自动增高等读写 style/selectionStart）与 focus()
defineExpose({ el, focus });
</script>

<template>
  <textarea
    ref="el"
    :class="[
      'w-full resize-none rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400',
      'focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
      'dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder:text-gray-500',
      'disabled:cursor-not-allowed disabled:opacity-50',
    ]"
  />
</template>
