<script setup lang="ts">
import Skeleton from "./Skeleton.vue";
</script>

<template>
  <div class="space-y-3">
    <div v-for="i in 3" :key="i" class="flex items-center gap-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
      <Skeleton class="w-10 h-10 rounded-full shrink-0" />
      <div class="flex-1 space-y-2">
        <Skeleton class="h-4 w-32" />
        <Skeleton class="h-3 w-48" />
      </div>
    </div>
  </div>
</template>
