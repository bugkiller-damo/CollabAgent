<script setup lang="ts">
import { Bell, CodeXml, ShieldCheck, User } from "@lucide/vue";
import { type Component, computed, markRaw } from "vue";
import { useRoute } from "vue-router";
import NavItem from "../../components/ui/NavItem.vue";

const items: { to: string; label: string; icon: Component }[] = [
  { to: "/settings/profile", label: "个人资料", icon: markRaw(User) },
  { to: "/settings/security", label: "安全与账户", icon: markRaw(ShieldCheck) },
  { to: "/settings/integrations", label: "集成", icon: markRaw(CodeXml) },
  { to: "/settings/notifications", label: "通知", icon: markRaw(Bell) },
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
            <component :is="i.icon" class="h-4 w-4" />
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
