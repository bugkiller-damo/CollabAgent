<script setup lang="ts">
import Skeleton from "./Skeleton.vue";
</script>

<template>
  <div class="space-y-1 p-2">
    <Skeleton v-for="i in 3" :key="i" class="h-7 w-full" />
  </div>
</template>
