<script setup lang="ts">
import { ChartColumn, Menu, Users } from "@lucide/vue";
import { type Component, computed, markRaw } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import PageHeader from "../../components/layout/PageHeader.vue";
import NavItem from "../../components/ui/NavItem.vue";
import { useInstanceAdmin } from "../../composables";

// 工作区级 Tab（频道 / 成员 / 指标）。Agent CRUD 已迁到 /computers 与成员档案。
const allTabs: { to: string; label: string; desc: string; icon: Component }[] = [
  { to: "/admin/channels", label: "频道管理", desc: "创建、归档、删除频道", icon: markRaw(Menu) },
  { to: "/admin/members", label: "成员管理", desc: "邀请、移除、角色分配", icon: markRaw(Users) },
  { to: "/admin/metrics", label: "运行指标", desc: "在线状态、消息量、资源占用", icon: markRaw(ChartColumn) },
];

const route = useRoute();
// 对齐 React useLocation().pathname === "/admin"（导航时随路由变化重新求值）
const isRoot = computed(() => route.path === "/admin");

// W-A4：metrics tab 按实例 admin 推导隐藏（/api/metrics 仅 admin 可读，P1.30）；
// 加载中（null）先显示，解析后非 admin 收起——直链 /admin/metrics 仍有 403 红字兜底
const { isInstanceAdmin } = useInstanceAdmin();
const tabs = computed(() =>
  isInstanceAdmin.value === false ? allTabs.filter((t) => t.to !== "/admin/metrics") : allTabs,
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader title="管理后台">
      <nav class="flex items-center gap-1 overflow-x-auto">
        <NavItem v-for="t in tabs" :key="t.to" :to="t.to">
          <template #icon>
            <component :is="t.icon" class="h-4 w-4" />
          </template>
          {{ t.label }}
        </NavItem>
      </nav>
    </PageHeader>

    <div class="flex-1 overflow-y-auto">
      <div v-if="isRoot" class="mx-auto w-full max-w-7xl p-4 sm:p-6">
        <h3 class="mb-4 text-base font-semibold text-ink">管理概览</h3>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <RouterLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="rounded-lg border border-gray-200 bg-gray-50 p-4 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            <div class="mb-2 text-muted">
              <component :is="t.icon" class="h-4 w-4" />
            </div>
            <h4 class="font-semibold text-ink">{{ t.label }}</h4>
            <p class="mt-1 text-sm text-muted">{{ t.desc }}</p>
          </RouterLink>
        </div>
      </div>
      <RouterView v-else />
    </div>
  </div>
</template>
