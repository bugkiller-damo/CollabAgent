<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../api";
import MarkdownContent from "../components/chat/MarkdownContent.vue";
import MessageComposer from "../components/chat/MessageComposer.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import Avatar from "../components/ui/Avatar.vue";
import type { MentionScope } from "../composables";
import { formatTime } from "../lib/formatTime";
import { useChannelStore, useMessageStore } from "../stores";

interface ThreadMsg {
  id: string;
  channel_id: string;
  sender_id: string;
  senderName: string;
  content: string;
  seq: number;
  time: string;
}

const route = useRoute();
const router = useRouter();
const messageStore = useMessageStore();
const channelStore = useChannelStore();

const channelName = computed(() => route.params.channelName as string);
const threadId = computed(() => route.params.threadId as string);

const threadKey = computed(() => {
  if (!channelName.value || !threadId.value) return "";
  return `${channelName.value}:${threadId.value.substring(0, 8)}`;
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
let fetchedThreadId: string | null = null;

async function loadThread() {
  if (!threadId.value) return;
  try {
    const data = await apiClient<{ parent: ThreadMsg; replies: ThreadMsg[] }>(
      `/api/messages/thread/${threadId.value}`,
      { method: "GET" },
    );
    parent.value = data.parent;
    replies.value = data.replies || [];
  } catch {
    error.value = "加载线程失败";
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
      content: m.content,
      seq: m.seq,
      time: m.time,
    } as ThreadMsg);
  }
  if (merged.length > 0) replies.value = [...prev, ...merged];
});

async function handleSend(content: string) {
  if (!content.trim() || !channelName.value || !threadId.value) return;
  try {
    await apiClient("/api/messages/send", {
      method: "POST",
      body: { target: `#${channelName.value}:${threadId.value}`, content, threadId: threadId.value },
    });
    await loadThread();
  } catch {
    error.value = "回复失败";
    throw new Error("回复失败");
  }
}

const mentionScope = computed<MentionScope>(() => ({
  channelId: parent.value?.channel_id ?? (currentChannel.value as any)?.id,
  channelType: (currentChannel.value as any)?.type,
}));

function localeString(iso: string): string {
  return new Date(iso).toLocaleString();
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

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div
        v-if="parent"
        class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="mb-2 flex items-center gap-2">
          <Avatar :name="parent.senderName || parent.sender_id" size="md" />
          <span class="text-sm font-semibold text-gray-900 dark:text-white">
            {{ parent.senderName || parent.sender_id }}
          </span>
          <span class="text-xs text-gray-500 dark:text-gray-400" :title="localeString(parent.time)">
            {{ formatTime(parent.time) }}
          </span>
        </div>
        <MarkdownContent :content="parent.content" />
      </div>

      <div v-if="replies.length > 0" class="flex items-center gap-2">
        <div class="flex-1 border-t border-gray-200 dark:border-gray-700" />
        <span class="text-xs text-gray-500 dark:text-gray-400">{{ replies.length }} 条回复</span>
        <div class="flex-1 border-t border-gray-200 dark:border-gray-700" />
      </div>

      <div
        v-for="msg in replies"
        :key="msg.id"
        class="group flex gap-3 rounded p-2 hover:bg-gray-100 dark:hover:bg-gray-800/50"
      >
        <Avatar :name="msg.senderName || msg.sender_id" size="md" />
        <div class="min-w-0">
          <div class="flex items-baseline gap-2">
            <span class="text-sm font-semibold text-gray-900 dark:text-white">
              {{ msg.senderName || msg.sender_id }}
            </span>
            <span class="text-xs text-gray-500 dark:text-gray-400" :title="localeString(msg.time)">
              {{ formatTime(msg.time) }}
            </span>
          </div>
          <MarkdownContent :content="msg.content" />
        </div>
      </div>

      <p v-if="replies.length === 0 && parent" class="text-center text-sm text-gray-500 dark:text-gray-400">
        还没有回复，说点什么吧
      </p>
    </div>

    <div class="border-t border-gray-200 p-4 dark:border-gray-700">
      <MessageComposer
        placeholder="回复线程... (Enter 发送, Shift+Enter 换行, @ 提及)"
        :on-send="handleSend"
        :mention-scope="mentionScope"
      />
    </div>
  </div>
</template>
