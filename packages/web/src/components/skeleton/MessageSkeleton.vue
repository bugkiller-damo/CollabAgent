<script setup lang="ts">
import Skeleton from "./Skeleton.vue";
</script>

<template>
  <div class="space-y-4 p-4">
    <div v-for="i in 5" :key="i" class="flex gap-3">
      <Skeleton class="w-8 h-8 rounded shrink-0" />
      <div class="flex-1 space-y-2">
        <Skeleton class="h-3 w-24" />
        <Skeleton :class="'h-3 ' + (i % 2 ? 'w-3/4' : 'w-1/2')" />
      </div>
    </div>
  </div>
</template>
