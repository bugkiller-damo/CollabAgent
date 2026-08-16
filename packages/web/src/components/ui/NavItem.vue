<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";

const props = withDefaults(
  defineProps<{
    to: string;
    end?: boolean;
  }>(),
  {
    end: false,
  },
);

const route = useRoute();
// 对齐 React 版：end 时精确匹配，否则前缀匹配 location.pathname（Vue 对应 route.path）
const active = computed(() => (props.end ? route.path === props.to : route.path.startsWith(props.to)));
</script>

<template>
  <RouterLink
    :to="to"
    :class="[
      'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
      active
        ? 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-700 dark:text-white'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white',
    ]"
  >
    <span v-if="$slots.icon" class="shrink-0"><slot name="icon" /></span>
    <span class="truncate"><slot /></span>
  </RouterLink>
</template>
