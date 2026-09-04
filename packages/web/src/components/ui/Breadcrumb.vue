<script setup lang="ts">
import { RouterLink } from "vue-router";

interface BreadcrumbItem {
  label: string;
  to?: string;
}

defineProps<{
  items: BreadcrumbItem[];
}>();
</script>

<template>
  <nav aria-label="breadcrumb" class="flex items-center gap-1.5 text-sm text-muted">
    <span v-for="(item, idx) in items" :key="idx" class="flex items-center gap-1.5">
      <span v-if="idx > 0" class="text-gray-300 dark:text-gray-600">/</span>
      <RouterLink v-if="item.to && idx < items.length - 1" :to="item.to" class="hover:text-blue-500 hover:underline">
        {{ item.label }}
      </RouterLink>
      <span v-else :class="idx === items.length - 1 ? 'font-medium text-ink' : ''">{{ item.label }}</span>
    </span>
  </nav>
</template>
