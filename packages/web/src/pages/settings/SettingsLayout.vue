<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import NavItem from "../../components/ui/NavItem.vue";

const items = [
  {
    to: "/settings/profile",
    label: "个人资料",
    d: "M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z",
  },
  {
    to: "/settings/security",
    label: "安全与账户",
    d: "M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z",
  },
  {
    to: "/settings/integrations",
    label: "集成",
    d: "M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5",
  },
  {
    to: "/settings/notifications",
    label: "通知",
    d: "M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0",
  },
];

const route = useRoute();
const current = computed(() => items.find((i) => route.path.startsWith(i.to)));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <nav class="border-b border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800 lg:w-56 lg:border-b-0 lg:border-r">
      <div class="space-y-1 lg:space-y-1">
        <NavItem v-for="i in items" :key="i.to" :to="i.to">
          <template #icon>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" :d="i.d" />
            </svg>
          </template>
          {{ i.label }}
        </NavItem>
      </div>
    </nav>
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        v-if="current"
        class="border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800 lg:hidden"
      >
        <h2 class="text-lg font-bold text-ink">{{ current.label }}</h2>
      </div>
      <div class="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <router-view />
      </div>
    </div>
  </div>
</template>
