<script setup lang="ts">
import { ChevronLeft } from "@lucide/vue";
import { RouterLink } from "vue-router";
import Breadcrumb from "../ui/Breadcrumb.vue";

interface BreadcrumbItem {
  label: string;
  to?: string;
}

withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    breadcrumb?: BreadcrumbItem[];
    backTo?: string;
    className?: string;
  }>(),
  {
    className: "",
  },
);
</script>

<template>
  <div :class="['border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800', className]">
    <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-center gap-2">
        <RouterLink
          v-if="backTo"
          :to="backTo"
          class="mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
          aria-label="返回"
        >
          <ChevronLeft class="h-5 w-5" />
        </RouterLink>
        <div v-if="$slots.leading" class="shrink-0"><slot name="leading" /></div>
        <div class="min-w-0">
          <div v-if="breadcrumb && breadcrumb.length > 0" class="mb-1">
            <Breadcrumb :items="breadcrumb" />
          </div>
          <div class="flex items-center gap-2">
            <h2 class="shrink-0 text-lg font-bold text-ink">{{ title }}</h2>
            <span
              v-if="subtitle"
              class="max-w-[10rem] truncate text-xs text-muted sm:max-w-xs md:max-w-sm"
              :title="subtitle"
            >
              {{ subtitle }}
            </span>
          </div>
        </div>
      </div>
      <div v-if="$slots.default" class="mt-2 flex shrink-0 items-center gap-2 sm:mt-0">
        <slot />
      </div>
    </div>
  </div>
</template>
