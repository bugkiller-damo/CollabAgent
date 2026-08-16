<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiGet, apiClient } from "../api";
import { useMessageStore, useUiStore } from "../stores";
import type { Message } from "@collabagent/shared";
import MessageRow from "../components/chat/MessageRow.vue";
import EmptyState from "../components/EmptyState.vue";
import MessageSkeleton from "../components/skeleton/MessageSkeleton.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import MessageComposer, { type ComposerAttachment } from "../components/chat/MessageComposer.vue";
import Avatar from "../components/ui/Avatar.vue";

const EMPTY: Message[] = [];

interface Peer {
  id: string;
  type: "human" | "agent";
  handle: string;
  displayName?: string;
}

const route = useRoute();
const messageStore = useMessageStore();
const uiStore = useUiStore();

const peerName = computed(() => route.params.peerName as string);
const peer = ref<Peer | null>(null);
const convKey = ref("");
const error = ref("");
const attachments = ref<ComposerAttachment[]>([]);
const containerRef = ref<HTMLDivElement | null>(null);

// 对应 React 版 useMessageStore((s) => (convKey && s.messagesByTarget[convKey]) || EMPTY)
const messages = computed<Message[]>(() => {
  if (!convKey.value) return EMPTY;
  return messageStore.messagesByTarget[convKey.value] || EMPTY;
});
const loading = computed(() => messageStore.loading);
const online = computed(() => uiStore.online);

const title = computed(() => peer.value?.displayName || peer.value?.handle || peerName.value || "私信");
const subtitle = computed(() => `@${peer.value?.handle || peerName.value || ""}`);
const isAgent = computed(() => peer.value?.type === "agent");

// React 版 useEffect([peerName, fetchHistory])：解析 dm:@peer → convKey，随后拉历史。
// fetchHistory 是 store 动作（引用稳定），故这里只 watch peerName。
watch(
  peerName,
  (name) => {
    if (!name) return;
    error.value = "";
    convKey.value = "";
    apiGet<{ channelId: string; dmKey: string; peer: Peer }>("/api/channels/resolve", { target: "dm:@" + name })
      .then((d) => {
        peer.value = d.peer;
        convKey.value = d.dmKey;
        messageStore.fetchHistory(d.dmKey).catch(() => {});
      })
      .catch((e: any) => {
        error.value = e?.message || "找不到该用户/Agent";
      });
  },
  { immediate: true },
);

// React 版 useEffect([messages])：新消息到达时，若接近底部则自动滚到底。
// flush: "post" 保证在 v-for 渲染出新消息（scrollHeight 更新）之后再读尺寸。
watch(
  messages,
  () => {
    const el = containerRef.value;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  },
  { flush: "post" },
);

function scrollToBottom() {
  setTimeout(() => {
    const el = containerRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  }, 50);
}

async function handleSend(content: string, attachmentIds: string[]) {
  if (!convKey.value) return;
  try {
    await apiClient("/api/messages/send", {
      method: "POST",
      body: { target: convKey.value, content, attachmentIds },
    });
    messageStore.fetchHistory(convKey.value).catch(() => {});
    scrollToBottom();
  } catch (err) {
    throw err;
  }
}

function setAttachments(next: ComposerAttachment[]) {
  attachments.value = next;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader :title="title" :subtitle="subtitle">
      <template #leading>
        <Avatar :name="title" size="md" />
      </template>
      <span
        v-if="isAgent"
        class="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-600 dark:bg-purple-900/40 dark:text-purple-300"
      >
        Agent
      </span>
    </PageHeader>

    <div v-if="error" class="flex flex-1 items-center justify-center p-4">
      <EmptyState icon="⚠️" title="无法打开私信" :description="error" />
    </div>

    <div v-else-if="messages.length === 0" class="min-h-0 flex-1 overflow-y-auto p-4">
      <MessageSkeleton v-if="loading" />
      <EmptyState
        v-else
        icon="✉️"
        title="还没有私信"
        :description="`发送第一条消息，开始和 ${title} 的私聊`"
      />
    </div>

    <div v-else ref="containerRef" class="min-h-0 flex-1 space-y-1 overflow-y-auto p-4">
      <MessageRow
        v-for="(m, idx) in messages"
        :key="m.id"
        :msg="m"
        :channel-name="convKey"
        :prev-msg="messages[idx - 1]"
      />
    </div>

    <div class="border-t border-gray-200 p-4 dark:border-gray-700">
      <MessageComposer
        :placeholder="`发私信给 ${title}... (Enter 发送, Shift+Enter 换行, @ 提及)`"
        :disabled="!!error || !convKey || !online"
        :attachments="attachments"
        :on-attachments-change="setAttachments"
        :on-send="handleSend"
      />
    </div>
  </div>
</template>
