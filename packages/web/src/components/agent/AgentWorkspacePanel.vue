<script setup lang="ts">
import type { AgentWorkspaceFile, AgentWorkspaceSnapshot } from "@collabagent/shared";
import { computed, ref, watch } from "vue";
import { apiGet } from "../../api";
import MarkdownContent from "../chat/MarkdownContent.vue";

const props = defineProps<{
  agentId: string;
  agentName: string;
  computerOnline?: boolean;
}>();

const loading = ref(false);
const listing = ref<AgentWorkspaceSnapshot | null>(null);
const selected = ref("MEMORY.md");
const content = ref("");
const contentError = ref("");
const contentLoading = ref(false);

const files = computed(() => listing.value?.files ?? []);
const empty = computed(() => listing.value?.exists === true && files.value.length === 0);
const offline = computed(() => listing.value == null && !loading.value && props.computerOnline === false);

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

async function loadList() {
  if (!props.agentId) return;
  loading.value = true;
  listing.value = null;
  content.value = "";
  contentError.value = "";
  try {
    listing.value = await apiGet<AgentWorkspaceSnapshot>(`/api/agents/${props.agentId}/workspace`);
    const first = listing.value.files?.find((f) => f.path === "MEMORY.md") || listing.value.files?.[0];
    selected.value = first?.path || "MEMORY.md";
    if (first) await loadFile(first.path);
  } catch (err: any) {
    const msg = String(err?.message || "");
    listing.value = { exists: false, files: [], error: msg };
  } finally {
    loading.value = false;
  }
}

async function loadFile(path: string) {
  selected.value = path;
  contentLoading.value = true;
  contentError.value = "";
  content.value = "";
  try {
    const r = await apiGet<AgentWorkspaceSnapshot>(`/api/agents/${props.agentId}/workspace`, { path });
    content.value = r.content || "";
    if (!r.content && r.error) contentError.value = r.error;
  } catch (err: any) {
    contentError.value = err?.message || "读取失败";
  } finally {
    contentLoading.value = false;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function label(f: AgentWorkspaceFile): string {
  return f.path === "MEMORY.md" ? "MEMORY.md" : f.path;
}

watch(
  () => [props.agentId, props.computerOnline] as const,
  () => {
    void loadList();
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="mb-2 flex shrink-0 items-center justify-end">
      <button
        type="button"
        class="text-[11px] text-blue-600 hover:underline dark:text-blue-400"
        :disabled="loading"
        @click="loadList"
      >
        刷新
      </button>
    </div>
    <p class="mb-2 shrink-0 text-xs text-gray-500">MEMORY.md 与 notes/（不含密钥与 CLAUDE.md）</p>
    <p v-if="loading" class="text-sm text-gray-400">加载中…</p>
    <p v-else-if="offline || listing?.error?.includes('offline')" class="text-sm text-gray-400">
      计算机离线，连上后可查看。
    </p>
    <p v-else-if="listing && !listing.exists" class="text-sm text-gray-400">
      还没有工作区。被 @ 拉起后会种入 MEMORY.md。
    </p>
    <p v-else-if="empty" class="text-sm text-gray-400">工作区已存在，但还没有可展示的笔记。</p>
    <div
      v-else-if="files.length"
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line"
    >
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <ul class="w-40 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50 text-xs dark:border-gray-700 dark:bg-gray-900/40">
          <li v-for="f in files" :key="f.path">
            <button
              type="button"
              :class="[
                'block w-full truncate px-2 py-1.5 text-left',
                selected === f.path
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
              ]"
              :title="`${f.path} · ${fmtBytes(f.bytes)}`"
              @click="loadFile(f.path)"
            >
              {{ label(f) }}
            </button>
          </li>
        </ul>
        <div class="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
          <p v-if="contentLoading" class="text-xs text-gray-400">读取中…</p>
          <p v-else-if="contentError" class="text-xs text-red-400">{{ contentError }}</p>
          <MarkdownContent v-else-if="isMarkdown(selected)" :content="content || '（空）'" />
          <pre v-else class="whitespace-pre-wrap break-all font-mono text-[11px] text-gray-700 dark:text-gray-300">{{
            content || "（空）"
          }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
