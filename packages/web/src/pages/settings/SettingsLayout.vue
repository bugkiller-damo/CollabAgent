<script setup lang="ts">
import { Bell, ChartColumn, CodeXml, LogOut, Server, ShieldCheck, User } from "@lucide/vue";
import { type Component, computed, markRaw } from "vue";
import { useRoute, useRouter } from "vue-router";
import NavItem from "../../components/ui/NavItem.vue";
import { useInstanceAdmin } from "../../composables";
import { useAuthStore } from "../../stores";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const items: { to: string; label: string; icon: Component; adminOnly?: boolean }[] = [
  { to: "/settings/profile", label: "个人资料", icon: markRaw(User) },
  { to: "/settings/server", label: "服务器资料", icon: markRaw(Server) },
  { to: "/settings/security", label: "安全与账户", icon: markRaw(ShieldCheck) },
  { to: "/settings/integrations", label: "集成", icon: markRaw(CodeXml) },
  { to: "/settings/notifications", label: "通知", icon: markRaw(Bell) },
  // 原管理后台管理页（2026-09-17 IA 收敛：/admin 并入设置；频道管理已删——频道页自带建/删/归档；
  // 成员管理 2026-09-18 融合进侧边栏成员页 PeopleView，不再单独成页）
  { to: "/settings/metrics", label: "运行指标", icon: markRaw(ChartColumn), adminOnly: true },
];

// W-A4：运行指标按实例 admin 显隐（/api/metrics 服务端 403 兜底；null=加载中先显示）
const { isInstanceAdmin } = useInstanceAdmin();
const visibleItems = computed(() => (isInstanceAdmin.value === false ? items.filter((i) => !i.adminOnly) : items));

function handleLogout() {
  authStore.logout();
  void router.push("/login");
}

const current = computed(() => items.find((i) => route.path.startsWith(i.to)));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <nav class="border-b border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800 lg:w-56 lg:border-b-0 lg:border-r">
      <div class="space-y-1 lg:space-y-1">
        <NavItem v-for="i in visibleItems" :key="i.to" :to="i.to">
          <template #icon>
            <component :is="i.icon" class="h-4 w-4" />
          </template>
          {{ i.label }}
        </NavItem>
      </div>
      <div class="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          @click="handleLogout"
        >
          <LogOut class="h-4 w-4 shrink-0" />
          退出登录
        </button>
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
