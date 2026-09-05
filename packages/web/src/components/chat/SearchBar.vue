<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { apiGet } from "../../api";
import { formatTime } from "../../lib/formatTime";
import MarkdownContent from "./MarkdownContent.vue";

interface SearchResult {
  id: string;
  content: string;
  channelId: string;
  seq: number;
  time: string;
}

const router = useRouter();
const query = ref("");
const results = ref<SearchResult[]>([]);
const open = ref(false);
const loading = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLDivElement | null>(null);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

async function doSearch(q: string) {
  if (!q.trim()) {
    results.value = [];
    return;
  }
  loading.value = true;
  try {
    const data = await apiGet<{ results: SearchResult[] }>("/api/messages/search", { q });
    results.value = data.results || [];
    open.value = true;
  } catch {
    results.value = [];
  } finally {
    loading.value = false;
  }
}

function handleInput(val: string) {
  query.value = val;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(val), 300);
}

function handleInputEvent(e: Event) {
  handleInput((e.target as HTMLInputElement).value);
}

function onFocus() {
  if (results.value.length > 0) open.value = true;
}

function onMousedown(e: MouseEvent) {
  const target = e.target as Node | null;
  if (!target) return;
  if (panelRef.value && panelRef.value.contains(target)) return;
  if (inputRef.value && inputRef.value.contains(target)) return;
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    open.value = false;
    inputRef.value?.blur();
  }
}

function navigateTo(r: SearchResult) {
  open.value = false;
  query.value = "";
  const ch = r.channelId?.startsWith("#") ? r.channelId.slice(1) : r.channelId;
  router.push(`/channels/${ch}#${r.id}`);
}

onMounted(() => document.addEventListener("mousedown", onMousedown));
onUnmounted(() => {
  document.removeEventListener("mousedown", onMousedown);
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="relative flex-1 max-w-sm">
    <div class="relative">
      <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-sm">🔍</span>
      <input
        ref="inputRef"
        type="text"
        :value="query"
        @input="handleInputEvent"
        @focus="onFocus"
        @keydown="onKeydown"
        placeholder="搜索消息..."
        class="w-full pl-8 pr-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-ink text-sm border border-transparent focus:outline-none focus:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 placeholder-gray-400"
      />
      <span v-if="loading" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted text-xs">⏳</span>
    </div>

    <div
      v-if="open && results.length > 0"
      ref="panelRef"
      class="absolute top-full mt-1 left-0 right-0 bg-surface border border-line rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto animate-slide-in-up origin-top"
    >
      <p class="text-xs text-muted px-3 py-1.5 border-b border-gray-100 dark:border-gray-700">
        找到 {{ results.length }} 条结果
      </p>
      <button
        v-for="r in results"
        :key="r.id"
        @click="navigateTo(r)"
        class="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-50 dark:border-gray-700/50 last:border-0"
      >
        <div class="flex items-center gap-2 text-xs text-gray-500 mb-0.5">
          <span>{{ r.channelId || "?" }}</span>
          <span>·</span>
          <span>{{ formatTime(r.time) }}</span>
        </div>
        <div class="text-sm text-ink line-clamp-2 [&_*]:!text-sm [&_*]:!leading-snug">
          <MarkdownContent :content="r.content" />
        </div>
      </button>
    </div>

    <div
      v-if="open && query && !loading && results.length === 0"
      ref="panelRef"
      class="absolute top-full mt-1 left-0 right-0 bg-surface border border-line rounded-lg shadow-xl z-50 p-4 text-center text-gray-500 text-sm animate-slide-in-up origin-top"
    >
      没有找到匹配的消息
    </div>
  </div>
</template>
