<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    className?: string;
  }>(),
  {
    className: "",
  },
);
</script>

<template>
  <div :class="['space-y-0.5', className]">
    <div v-if="title || $slots.action" class="flex items-center justify-between px-2 py-1.5">
      <span v-if="title" class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {{ title }}
      </span>
      <div v-if="$slots.action" class="flex items-center">
        <slot name="action" />
      </div>
    </div>
    <slot />
  </div>
</template>
