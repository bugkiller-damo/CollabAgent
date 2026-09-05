<script setup lang="ts">
defineProps<{
  agentName: string;
  text: string;
}>();
</script>

<template>
  <div class="flex items-center gap-2 px-4 py-2 bg-gray-100/80 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700 animate-pulse">
    <div class="w-2 h-2 rounded-full bg-amber-400"></div>
    <span class="text-amber-600 dark:text-amber-400 text-xs font-medium">{{ agentName }}</span>
    <span class="text-muted text-xs">{{ text }}</span>
  </div>
</template>
