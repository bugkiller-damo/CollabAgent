<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { apiGet } from "../../../api";
import { formatTime } from "../../../lib/formatTime";
import { useUiStore } from "../../../stores";
import MarkdownContent from "../../chat/MarkdownContent.vue";

interface SearchResult {
  id: string;
  content: string;
  channelId: string;
  seq: number;
  time: string;
}

const router = useRouter();
const uiStore = useUiStore();
const query = ref("");
const results = ref<SearchResult[]>([]);
const loading = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
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
  } catch {
    results.value = [];
  } finally {
    loading.value = false;
  }
}

function handleInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  query.value = val;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(val), 300);
}

function navigateTo(r: SearchResult) {
  query.value = "";
  results.value = [];
  const ch = r.channelId?.startsWith("#") ? r.channelId.slice(1) : r.channelId;
  uiStore.openSidebarPane("chat");
  uiStore.closeMobileDrawer();
  router.push(`/channels/${ch}#${r.id}`);
}

onMounted(() => {
  inputRef.value?.focus();
});
onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

defineExpose({ focus: () => inputRef.value?.focus() });
</script>

<template>
  <div class="flex h-full flex-col p-2">
    <div class="relative">
      <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">🔍</span>
      <input
        ref="inputRef"
        type="text"
        :value="query"
        placeholder="搜索消息..."
        class="w-full rounded-lg border border-transparent bg-white py-1.5 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none dark:bg-gray-700 dark:text-white"
        @input="handleInput"
      />
      <span v-if="loading" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">⏳</span>
    </div>

    <p v-if="results.length > 0" class="px-1 py-2 text-xs text-gray-400">找到 {{ results.length }} 条结果</p>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="r in results"
        :key="r.id"
        class="w-full border-b border-gray-100 px-2 py-2 text-left last:border-0 hover:bg-gray-200 dark:border-gray-700/50 dark:hover:bg-gray-700"
        @click="navigateTo(r)"
      >
        <div class="mb-0.5 flex items-center gap-2 text-xs text-gray-500">
          <span>{{ r.channelId || "?" }}</span>
          <span>·</span>
          <span>{{ formatTime(r.time) }}</span>
        </div>
        <div class="line-clamp-2 text-sm text-ink [&_*]:!text-sm [&_*]:!leading-snug">
          <MarkdownContent :content="r.content" />
        </div>
      </button>
      <p v-if="query && !loading && results.length === 0" class="px-2 py-6 text-center text-sm text-gray-500">
        没有找到匹配的消息
      </p>
      <p v-if="!query" class="px-2 py-6 text-center text-xs text-gray-400">输入关键词搜索频道消息</p>
    </div>
  </div>
</template>
