<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../api";
import AgentProgressBar from "../components/agent/AgentProgressBar.vue";
import MarkdownContent from "../components/chat/MarkdownContent.vue";
import MessageComposer from "../components/chat/MessageComposer.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import MessageSkeleton from "../components/skeleton/MessageSkeleton.vue";
import Avatar from "../components/ui/Avatar.vue";
import type { MentionScope } from "../composables";
import { formatTime } from "../lib/formatTime";
import { threadBufferKey, useChannelStore, useMessageStore, useUiStore } from "../stores";

interface ThreadMsg {
  id: string;
  channel_id: string;
  sender_id: string;
  senderName: string;
  senderHandle?: string;
  senderType?: string;
  content: string;
  seq: number;
  time: string;
}

const route = useRoute();
const router = useRouter();
const messageStore = useMessageStore();
const channelStore = useChannelStore();
const uiStore = useUiStore();

const channelName = computed(() => route.params.channelName as string);
const threadId = computed(() => route.params.threadId as string);

const threadKey = computed(() => {
  if (!channelName.value || !threadId.value) return "";
  // P0-2：与 wsDispatch 写入侧共用同一 key 约定（无 # 前缀），防口径漂移
  return threadBufferKey(channelName.value, threadId.value);
});

// React 版 useMessageStore((s) => (threadKey ? s.messagesByTarget[threadKey] : undefined)) || []
const liveReplies = computed<any[]>(() => {
  if (!threadKey.value) return [];
  return messageStore.messagesByTarget[threadKey.value] || [];
});

const currentChannel = computed(() => channelStore.channels.find((c: any) => c.name === channelName.value));

const parent = ref<ThreadMsg | null>(null);
const replies = ref<ThreadMsg[]>([]);
const error = ref("");
// P1-16：加载中标志——首载（parent 为 null）期间显示骨架，不再整块空白；
// 线程切换期间旧内容保持显示（stale-while-revalidate，防闪空）
const loading = ref(false);
// W-A3：发送失败独立可见——load error 只在 !parent 时渲染整页错误，
// 线程已加载时回复失败此前零反馈（仅草稿保留）
const sendError = ref("");
let fetchedThreadId: string | null = null;

async function loadThread() {
  if (!threadId.value) return;
  // 顺带项：清上次线程的失败残留——否则失败后切线程，加载期间误显上一线程的错误态
  error.value = "";
  loading.value = true;
  try {
    const data = await apiClient<{ parent: ThreadMsg; replies: ThreadMsg[] }>(
      `/api/messages/thread/${threadId.value}`,
      { method: "GET" },
    );
    parent.value = data.parent;
    replies.value = data.replies || [];
  } catch {
    error.value = "加载线程失败";
  } finally {
    loading.value = false;
  }
}

// React 版 useEffect([threadId])：首次进入 / 切换线程时加载一次（用 ref 记录已加载的 id 去重）。
watch(
  threadId,
  (id) => {
    if (id && fetchedThreadId !== id) {
      fetchedThreadId = id;
      loadThread();
    }
  },
  { immediate: true },
);

// React 版 useEffect([liveReplies])：把 WS 实时推入的回复（camelCase 的 Message）合并进
// 本地 snake_case 的 replies，按 id 去重。
watch(liveReplies, (live) => {
  if (live.length === 0) return;
  const prev = replies.value;
  const known = new Set(prev.map((r) => r.id));
  const merged: ThreadMsg[] = [];
  for (const m of live) {
    if (known.has(m.id)) continue;
    merged.push({
      id: m.id,
      channel_id: m.channelId,
      sender_id: m.senderId,
      senderName: m.senderName,
      senderHandle: m.senderHandle,
      content: m.content,
      seq: m.seq,
      time: m.time,
    } as ThreadMsg);
  }
  if (merged.length > 0) replies.value = [...prev, ...merged];
});

async function handleSend(content: string) {
  if (!content.trim() || !channelName.value || !threadId.value) return;
  sendError.value = "";
  try {
    await apiClient("/api/messages/send", {
      method: "POST",
      body: { target: `#${channelName.value}:${threadId.value}`, content, threadId: threadId.value },
    });
    await loadThread();
  } catch (err: any) {
    // 透出 server 400/403 原因（P1.33：content 上限/异频道 threadId/移出后无权限）；
    // rethrow 保留——MessageComposer 据此不清空草稿（doSend 侧已吞异常，不会 unhandled）
    sendError.value = err?.message || "回复失败";
    throw err;
  }
}

const mentionScope = computed<MentionScope>(() => ({
  channelId: parent.value?.channel_id ?? (currentChannel.value as any)?.id,
  channelType: (currentChannel.value as any)?.type,
}));

function localeString(iso: string): string {
  return new Date(iso).toLocaleString();
}

function openSender(msg: { senderHandle?: string }) {
  const h = String(msg.senderHandle || "").replace(/^@/, "");
  if (h) uiStore.openProfile({ handle: h, channelId: currentChannel.value?.id });
}
</script>

<template>
  <div v-if="error && !parent" class="flex flex-1 flex-col">
    <PageHeader
      title="线程"
      :breadcrumb="[{ label: '频道', to: `/channels/${channelName}` }, { label: '线程' }]"
    />
    <div class="flex flex-1 items-center justify-center p-4">
      <EmptyState
        icon="⚠️"
        title="加载失败"
        :description="error"
        action-label="返回频道"
        @action="router.push(`/channels/${channelName}`)"
      />
    </div>
  </div>

  <div v-else class="flex min-h-0 flex-1 flex-col">
    <PageHeader
      title="线程"
      :back-to="`/channels/${channelName}`"
      :breadcrumb="[{ label: `#${channelName}`, to: `/channels/${channelName}` }, { label: '线程' }]"
    />

    <AgentProgressBar :channel-name="channelName" />

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <!-- P1-16：加载中显示骨架（首载 parent 为 null 期间），不再整块空白 -->
      <MessageSkeleton v-if="loading && !parent" />
      <div
        v-else-if="parent"
        class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="mb-2 flex items-center gap-2">
          <button type="button" class="flex items-center gap-2" :disabled="!parent.senderHandle" @click="openSender(parent)">
            <Avatar :name="parent.senderName || parent.sender_id" size="md" />
            <span class="text-sm font-semibold text-gray-900 hover:underline dark:text-white">
              {{ parent.senderName || parent.sender_id }}
            </span>
          </button>
          <span class="text-xs text-muted" :title="localeString(parent.time)">
            {{ formatTime(parent.time) }}
          </span>
        </div>
        <MarkdownContent :content="parent.content" />
      </div>

      <div v-if="replies.length > 0" class="flex items-center gap-2">
        <div class="flex-1 border-t border-line" />
        <span class="text-xs text-muted">{{ replies.length }} 条回复</span>
        <div class="flex-1 border-t border-line" />
      </div>

      <div
        v-for="msg in replies"
        :key="msg.id"
        class="group flex gap-3 rounded p-2 hover:bg-gray-100 dark:hover:bg-gray-800/50"
      >
        <button type="button" class="shrink-0" :disabled="!msg.senderHandle" @click="openSender(msg)">
          <Avatar :name="msg.senderName || msg.sender_id" size="md" />
        </button>
        <div class="min-w-0">
          <div class="flex items-baseline gap-2">
            <button
              type="button"
              class="text-sm font-semibold text-gray-900 hover:underline disabled:no-underline dark:text-white"
              :disabled="!msg.senderHandle"
              @click="openSender(msg)"
            >
              {{ msg.senderName || msg.sender_id }}
            </button>
            <span class="text-xs text-muted" :title="localeString(msg.time)">
              {{ formatTime(msg.time) }}
            </span>
          </div>
          <MarkdownContent :content="msg.content" />
        </div>
      </div>

      <p v-if="replies.length === 0 && parent" class="text-center text-sm text-muted">
        还没有回复，说点什么吧
      </p>
    </div>

    <div class="border-t border-gray-200 p-4 dark:border-gray-700">
      <p v-if="sendError" class="mb-2 text-xs text-red-500">回复失败：{{ sendError }}</p>
      <MessageComposer
        placeholder="回复线程... (Enter 发送, Shift+Enter 换行, @ 提及)"
        :on-send="handleSend"
        :mention-scope="mentionScope"
      />
    </div>
  </div>
</template>
