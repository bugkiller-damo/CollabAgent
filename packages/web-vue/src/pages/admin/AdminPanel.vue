<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import PageHeader from "../../components/layout/PageHeader.vue";
import NavItem from "../../components/ui/NavItem.vue";

// React 版 tabs 数组 + 4 个 SVG 图标（每个图标均为单一 <path>，此处只保留 d 值，
// 由模板统一渲染为同一 <svg>，与 React 版标记完全一致）
const tabs = [
  { to: "/admin/agents", label: "Agent 管理", desc: "注册、配置、监控 AI Agent", d: "M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" },
  { to: "/admin/channels", label: "频道管理", desc: "创建、归档、删除频道", d: "M5.25 8.25h13.5m-13.5 4.5h13.5m-13.5 4.5h13.5" },
  { to: "/admin/members", label: "成员管理", desc: "邀请、移除、角色分配", d: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.295-2.228-.837-3.244M15 19.128c.956.6 2.04.872 3.124.872M7.5 14.251c.956.6 2.04.872 3.124.872 1.085 0 2.169-.273 3.124-.872M7.5 14.251c.63.394 1.343.6 2.076.6h.017c.734 0 1.446-.206 2.076-.6m-4.17-.6a4.125 4.125 0 0 1-7.532 2.493 9.337 9.337 0 0 1 4.121-.952 9.38 9.38 0 0 1 2.625.372m9.94 3.198-1.807-1.626a4.125 4.125 0 0 0-5.512 0l-1.806 1.626M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  { to: "/admin/metrics", label: "运行指标", desc: "在线状态、消息量、资源占用", d: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" },
];

const route = useRoute();
// 对齐 React useLocation().pathname === "/admin"（导航时随路由变化重新求值）
const isRoot = computed(() => route.path === "/admin");
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader title="管理后台">
      <nav class="flex items-center gap-1 overflow-x-auto">
        <NavItem v-for="t in tabs" :key="t.to" :to="t.to">
          <template #icon>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" :d="t.d" />
            </svg>
          </template>
          {{ t.label }}
        </NavItem>
      </nav>
    </PageHeader>

    <div class="flex-1 overflow-y-auto">
      <div v-if="isRoot" class="mx-auto w-full max-w-7xl p-4 sm:p-6">
        <h3 class="mb-4 text-base font-semibold text-gray-900 dark:text-white">管理概览</h3>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <RouterLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="rounded-lg border border-gray-200 bg-gray-50 p-4 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            <div class="mb-2 text-gray-500 dark:text-gray-400">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" :d="t.d" />
              </svg>
            </div>
            <h4 class="font-semibold text-gray-900 dark:text-white">{{ t.label }}</h4>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t.desc }}</p>
          </RouterLink>
        </div>
      </div>
      <RouterView v-else />
    </div>
  </div>
</template>
