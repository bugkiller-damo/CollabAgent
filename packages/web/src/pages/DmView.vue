<script setup lang="ts">
import type { Message } from "@collabagent/shared";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, apiGet } from "../api";
import AgentProgressBar from "../components/agent/AgentProgressBar.vue";
import MessageComposer, { type ComposerAttachment } from "../components/chat/MessageComposer.vue";
import MessageRow from "../components/chat/MessageRow.vue";
import PendingRow from "../components/chat/PendingRow.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import MessageSkeleton from "../components/skeleton/MessageSkeleton.vue";
import Avatar from "../components/ui/Avatar.vue";
import { useMessageStore, useUiStore } from "../stores";

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
const stickToBottom = ref(true);

// 对应 React 版 useMessageStore((s) => (convKey && s.messagesByTarget[convKey]) || EMPTY)
const messages = computed<Message[]>(() => {
  if (!convKey.value) return EMPTY;
  return messageStore.messagesByTarget[convKey.value] || EMPTY;
});
// 离线发送队列归 store 按 target 持久化（对齐 ChannelView）
const pending = computed(() => (convKey.value ? messageStore.pendingByTarget[convKey.value] : undefined) || []);
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
    stickToBottom.value = true;
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

function pinToBottom() {
  const el = containerRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onListScroll() {
  const el = containerRef.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

watch(
  [messages, pending],
  () => {
    if (!stickToBottom.value) return;
    nextTick(() => {
      pinToBottom();
      requestAnimationFrame(pinToBottom);
    });
  },
  { flush: "post" },
);

function scrollToBottom() {
  stickToBottom.value = true;
  nextTick(() => {
    pinToBottom();
    requestAnimationFrame(pinToBottom);
  });
}

async function handleSend(content: string, attachmentIds: string[]) {
  if (!convKey.value) return;
  if (attachmentIds.length > 0) {
    // 附件路径保持现状：直发，不进离线队列
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
    return;
  }

  // 纯文本对齐 ChannelView：入队（带 clientNonce 幂等键）→ 离线仅排队，在线立即 flush
  const trimmed = content.trim();
  if (!trimmed) return;
  messageStore.enqueuePending(convKey.value, trimmed);
  scrollToBottom();
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  messageStore.flushPending(convKey.value).catch(() => {});
}

function retryPending(tempId: string) {
  if (!convKey.value) return;
  messageStore.retryPending(convKey.value, tempId).catch(() => {});
}

function discardPending(tempId: string) {
  if (!convKey.value) return;
  messageStore.discardPending(convKey.value, tempId);
}

// 恢复在线时补发离线排队消息（对齐 ChannelView 的 online watch）
watch(
  online,
  (isOnline) => {
    if (!isOnline || !convKey.value) return;
    messageStore.flushPending(convKey.value).catch(() => {});
  },
  { immediate: true },
);

function setAttachments(next: ComposerAttachment[]) {
  attachments.value = next;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader :title="title" :subtitle="subtitle">
      <template #leading>
        <button type="button" class="flex items-center" @click="uiStore.openProfile({ handle: peer?.handle || peerName })">
          <Avatar :name="title" size="md" />
        </button>
      </template>
      <span
        v-if="isAgent"
        class="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-600 dark:bg-purple-900/40 dark:text-purple-300"
      >
        Agent
      </span>
    </PageHeader>

    <AgentProgressBar :channel-name="'dm:@' + (peer?.handle || peerName)" :agent-name="isAgent ? peer?.handle || peerName : undefined" />

    <div v-if="error" class="flex flex-1 items-center justify-center p-4">
      <EmptyState icon="⚠️" title="无法打开私信" :description="error" />
    </div>

    <div v-else-if="messages.length === 0 && pending.length === 0" class="min-h-0 flex-1 overflow-y-auto p-4">
      <MessageSkeleton v-if="loading" />
      <EmptyState
        v-else
        icon="✉️"
        title="还没有私信"
        :description="`发送第一条消息，开始和 ${title} 的私聊`"
      />
    </div>

    <div v-else ref="containerRef" class="min-h-0 flex-1 space-y-1 overflow-y-auto p-4" @scroll.passive="onListScroll">
      <MessageRow
        v-for="(m, idx) in messages"
        :key="m.id"
        :msg="m"
        :channel-name="convKey"
        :prev-msg="messages[idx - 1]"
      />
      <PendingRow v-for="p in pending" :key="p.tempId" :item="p" @retry="retryPending" @discard="discardPending" />
    </div>

    <div class="border-t border-gray-200 p-4 dark:border-gray-700">
      <MessageComposer
        :placeholder="`发私信给 ${title}... (Enter 发送, Shift+Enter 换行, @ 提及)`"
        :disabled="!!error || !convKey"
        :attachments="attachments"
        :on-attachments-change="setAttachments"
        :on-send="handleSend"
      />
    </div>
  </div>
</template>
