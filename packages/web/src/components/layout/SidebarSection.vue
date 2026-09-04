<script setup lang="ts">
import { computed, ref, watch } from "vue";

const STORAGE_KEY = "slock.sidebar.sections";

const props = withDefaults(
  defineProps<{
    title?: string;
    className?: string;
    /** 持久化折叠状态的键；不传则不记忆 */
    persistKey?: string;
    /** 标题旁计数，折叠时仍能看到有多少项 */
    count?: number;
    defaultCollapsed?: boolean;
  }>(),
  {
    className: "",
    defaultCollapsed: false,
  },
);

function readStored(): boolean | null {
  if (!props.persistKey || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, unknown>;
    if (typeof map[props.persistKey] === "boolean") return map[props.persistKey] as boolean;
  } catch {
    /* ignore */
  }
  return null;
}

function writeStored(collapsed: boolean) {
  if (!props.persistKey || typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    map[props.persistKey] = collapsed;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota */
  }
}

const collapsed = ref(readStored() ?? props.defaultCollapsed);

watch(
  () => props.persistKey,
  () => {
    collapsed.value = readStored() ?? props.defaultCollapsed;
  },
);

function toggle() {
  if (!props.title) return;
  collapsed.value = !collapsed.value;
  writeStored(collapsed.value);
}

const countLabel = computed(() => (typeof props.count === "number" ? String(props.count) : ""));
</script>

<template>
  <div :class="['space-y-0.5', className]">
    <div v-if="title || $slots.action" class="flex items-center justify-between gap-1 px-1 py-0.5">
      <button
        v-if="title"
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left hover:bg-gray-200/80 dark:hover:bg-gray-700/80"
        :aria-expanded="!collapsed"
        @click="toggle"
      >
        <svg
          class="h-3 w-3 shrink-0 text-gray-400 transition-transform"
          :class="collapsed ? '-rotate-90' : ''"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
        <span class="truncate text-xs font-semibold uppercase tracking-wider text-muted">
          {{ title }}
        </span>
        <span v-if="countLabel" class="shrink-0 text-[10px] tabular-nums text-gray-400">{{ countLabel }}</span>
      </button>
      <div v-if="$slots.action" class="flex shrink-0 items-center">
        <slot name="action" />
      </div>
    </div>
    <div v-show="!collapsed">
      <slot />
    </div>
  </div>
</template>
