<script setup lang="ts">
import { computed } from "vue";
import { useAuthStore, useUiStore } from "../../stores";
import Avatar from "../ui/Avatar.vue";
import Tooltip from "../ui/Tooltip.vue";

/**
 * 左下角头像：纯展示（无点击、无二级菜单，2026-09-17 IA 收敛——
 * 原弹出菜单的 深色模式 → rail 底部按钮、退出登录/管理后台 → 设置页）。
 * 保留原 UserMenu 的连接状态环（WS 状态着色）。
 */
const authStore = useAuthStore();
const uiStore = useUiStore();

const displayName = computed(() => authStore.user?.displayName || authStore.user?.handle || "User");

const ringClass = computed(() => {
  if (!uiStore.online) return "ring-2 ring-amber-500";
  if (uiStore.wsStatus === "connected") return "ring-2 ring-green-500";
  if (uiStore.wsStatus === "connecting" || uiStore.wsStatus === "reconnecting") return "ring-2 ring-amber-400";
  return "ring-2 ring-red-500";
});
</script>

<template>
  <Tooltip :label="displayName" position="right">
    <span class="flex h-10 w-10 cursor-default items-center justify-center">
      <span :class="['rounded-full', ringClass]">
        <Avatar :name="displayName" :src="(authStore.user as any)?.avatarUrl" size="sm" />
      </span>
    </span>
  </Tooltip>
</template>
