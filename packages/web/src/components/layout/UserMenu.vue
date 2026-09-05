<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useInstanceAdmin } from "../../composables";
import { useAuthStore, useUiStore } from "../../stores";
import Avatar from "../ui/Avatar.vue";
import Tooltip from "../ui/Tooltip.vue";

const props = withDefaults(
  defineProps<{
    compact?: boolean;
  }>(),
  { compact: false },
);

const authStore = useAuthStore();
const uiStore = useUiStore();
const router = useRouter();

const open = ref(false);
const rootEl = ref<HTMLDivElement | null>(null);

function onClickOutside(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener("mousedown", onClickOutside));
onUnmounted(() => document.removeEventListener("mousedown", onClickOutside));

const user = computed(() => authStore.user);
const theme = computed(() => uiStore.theme);
const displayName = computed(() => user.value?.displayName || user.value?.handle || "User");
// W-A4：admin 入口角色感知——非实例 admin 不渲染「管理后台」（null=加载中也不渲染）
const { isInstanceAdmin } = useInstanceAdmin();

const ringClass = computed(() => {
  if (!uiStore.online) return "ring-2 ring-amber-500";
  if (uiStore.wsStatus === "connected") return "ring-2 ring-green-500";
  if (uiStore.wsStatus === "connecting" || uiStore.wsStatus === "reconnecting") return "ring-2 ring-amber-400";
  return "ring-2 ring-red-500";
});

function handleLogout() {
  authStore.logout();
  router.push("/login");
}

function toggleTheme() {
  uiStore.setTheme(theme.value === "dark" ? "light" : "dark");
}

function go(path: string) {
  open.value = false;
  void router.push(path);
}
</script>

<template>
  <div ref="rootEl" :class="['relative', compact ? '' : 'border-t border-gray-200 p-2 dark:border-gray-700']">
    <Tooltip v-if="compact" :label="displayName" position="right">
      <button
        type="button"
        class="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-raised"
        :aria-label="displayName"
        @click="open = !open"
      >
        <span :class="['rounded-full', ringClass]">
          <Avatar :name="displayName" :src="(user as any)?.avatarUrl" size="sm" />
        </span>
      </button>
    </Tooltip>
    <button
      v-else
      type="button"
      class="flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-raised"
      @click="open = !open"
    >
      <span :class="['rounded-full', ringClass]">
        <Avatar :name="displayName" :src="(user as any)?.avatarUrl" size="md" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-ink">{{ displayName }}</p>
        <p class="truncate text-xs text-gray-500">@{{ user?.handle || "unknown" }}</p>
      </div>
      <svg class="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      </svg>
    </button>

    <div
      v-if="open"
      :class="[
        'absolute z-50 rounded-lg border border-gray-200 bg-white py-1 shadow-lg animate-scale-in dark:border-gray-700 dark:bg-gray-800',
        compact
          ? 'bottom-0 left-full ml-2 w-52 origin-bottom-left'
          : 'bottom-full left-2 right-2 mb-1 origin-bottom-left',
      ]"
    >
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="go('/settings/profile')"
      >
        个人资料
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="toggleTheme"
      >
        {{ theme === "dark" ? "浅色模式" : "深色模式" }}
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="go('/computers')"
      >
        计算机
      </button>
      <button
        v-if="isInstanceAdmin === true"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="go('/admin')"
      >
        管理后台
      </button>
      <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
        @click="handleLogout"
      >
        退出登录
      </button>
    </div>
  </div>
</template>
