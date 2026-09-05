<script setup lang="ts">
import { ChevronDown, LogOut, Moon, Settings, Sun } from "@lucide/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore, useUiStore } from "../../stores";
import Avatar from "../ui/Avatar.vue";

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

function handleLogout() {
  authStore.logout();
  router.push("/login");
}

function toggleTheme() {
  uiStore.setTheme(theme.value === "dark" ? "light" : "dark");
}
</script>

<template>
  <div ref="rootEl" class="relative border-t border-gray-200 p-2 dark:border-gray-700">
    <button
      class="flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-raised"
      @click="open = !open"
    >
      <Avatar :name="displayName" :src="(user as any)?.avatarUrl" size="md" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-ink">{{ displayName }}</p>
        <p class="truncate text-xs text-gray-500">@{{ user?.handle || "unknown" }}</p>
      </div>
      <ChevronDown class="h-4 w-4 shrink-0 text-muted" />
    </button>

    <div
      v-if="open"
      class="absolute bottom-full left-2 right-2 mb-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg animate-scale-in origin-bottom-left dark:border-gray-700 dark:bg-gray-800"
    >
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="open = false; router.push('/settings/profile')"
      >
        <span class="shrink-0">
          <Settings class="h-4 w-4" />
        </span>
        设置
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="toggleTheme"
      >
        <span class="shrink-0">
          <Sun v-if="theme === 'dark'" class="h-4 w-4" />
          <Moon v-else class="h-4 w-4" />
        </span>
        {{ theme === "dark" ? "浅色模式" : "深色模式" }}
      </button>
      <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
        @click="handleLogout"
      >
        <span class="shrink-0">
          <LogOut class="h-4 w-4" />
        </span>
        退出登录
      </button>
    </div>
  </div>
</template>
