<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useUiStore } from "../../stores";
import MemberProfileBody from "./MemberProfileBody.vue";

const uiStore = useUiStore();

const handle = computed(() => uiStore.profileTarget?.handle || "");
const channelId = computed(() => uiStore.profileTarget?.channelId);

function close() {
  uiStore.closeProfile();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && uiStore.profileTarget) {
    e.preventDefault();
    close();
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="fixed inset-0 z-40 bg-black/40 lg:hidden" @click="close" />
  <aside
    class="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 lg:static lg:z-auto lg:w-[380px] lg:shrink-0"
    role="dialog"
    aria-label="成员档案"
  >
    <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
      <span class="text-sm font-semibold text-gray-800 dark:text-gray-200">档案</span>
      <button type="button" class="text-sm text-muted hover:text-gray-700 dark:hover:text-white" @click="close">
        ✕
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <MemberProfileBody v-if="handle" :handle="handle" :channel-id="channelId" />
    </div>
  </aside>
</template>
