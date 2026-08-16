<script setup lang="ts">
defineProps<{
  agentName: string;
  text: string;
}>();
</script>

<template>
  <div class="flex items-center gap-2 px-4 py-2 bg-gray-800/80 border-b border-gray-700 animate-pulse">
    <div class="w-2 h-2 rounded-full bg-yellow-400"></div>
    <span class="text-yellow-400 text-xs font-medium">{{ agentName }}</span>
    <span class="text-gray-500 text-xs">{{ text }}</span>
  </div>
</template>
