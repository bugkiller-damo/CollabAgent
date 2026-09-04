<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { apiGet } from "../api";
import MarkdownContent from "../components/chat/MarkdownContent.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import { formatTime } from "../lib/formatTime";
import { useUiStore } from "../stores";

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
  const ch = r.channelId?.startsWith("#") ? r.channelId.slice(1) : r.channelId;
  uiStore.openSidebarPane("chat");
  uiStore.closeMobileDrawer();
  void router.push(`/channels/${ch}#${r.id}`);
}

onMounted(() => {
  void nextTick(() => inputRef.value?.focus());
});
onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader title="搜索" subtitle="在频道消息里查找">
      <div class="relative w-full max-w-md">
        <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">🔍</span>
        <input
          ref="inputRef"
          type="text"
          :value="query"
          placeholder="搜索消息..."
          class="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          @input="handleInput"
        />
        <span v-if="loading" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">⏳</span>
      </div>
    </PageHeader>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="results.length > 0" class="px-4 py-2 text-xs text-gray-400">找到 {{ results.length }} 条结果</p>
      <button
        v-for="r in results"
        :key="r.id"
        type="button"
        class="w-full border-b border-gray-100 px-4 py-3 text-left last:border-0 hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-800/60"
        @click="navigateTo(r)"
      >
        <div class="mb-0.5 flex items-center gap-2 text-xs text-gray-500">
          <span>{{ r.channelId || "?" }}</span>
          <span>·</span>
          <span>{{ formatTime(r.time) }}</span>
        </div>
        <div class="line-clamp-3 text-sm text-ink [&_*]:!text-sm [&_*]:!leading-snug">
          <MarkdownContent :content="r.content" />
        </div>
      </button>
      <EmptyState
        v-if="query && !loading && results.length === 0"
        icon="🔍"
        title="没有找到匹配的消息"
        description="换个关键词再试"
      />
      <EmptyState v-if="!query" icon="🔍" title="搜索消息" description="输入关键词，在频道历史里查找" />
    </div>
  </div>
</template>
