<script setup lang="ts">
withDefaults(
  defineProps<{
    shimmer?: boolean;
  }>(),
  {
    shimmer: true,
  },
);
</script>

<template>
  <!-- 尺寸/形状由父级 class 控制（fallthrough 合并）；对齐 React 的 className 用法 -->
  <div
    :class="[
      'rounded',
      shimmer ? 'animate-shimmer bg-gray-300 dark:bg-gray-700' : 'animate-pulse bg-gray-300 dark:bg-gray-700',
    ]"
  />
</template>
