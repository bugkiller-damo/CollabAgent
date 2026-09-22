<script setup lang="ts">
import type { Message } from "@collabagent/shared";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiGet } from "../api";
import AgentProgressBar from "../components/agent/AgentProgressBar.vue";
import PendingInterruptBanner from "../components/agent/PendingInterruptBanner.vue";
import MessageComposer, { type ComposerAttachment } from "../components/chat/MessageComposer.vue";
import MessageRow from "../components/chat/MessageRow.vue";
import PendingRow from "../components/chat/PendingRow.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import MessageSkeleton from "../components/skeleton/MessageSkeleton.vue";
import Avatar from "../components/ui/Avatar.vue";
import { useChannelStore, useInterruptStore, useMessageStore, useUiStore } from "../stores";

const EMPTY: Message[] = [];

interface Peer {
  id: string;
  type: "human" | "agent";
  handle: string;
  displayName?: string;
  avatarUrl?: string | null;
}

const route = useRoute();
const messageStore = useMessageStore();
const channelStore = useChannelStore();
const uiStore = useUiStore();
const interruptStore = useInterruptStore();

const peerName = computed(() => route.params.peerName as string);
const peer = ref<Peer | null>(null);
const convKey = ref("");
// dm 频道 UUID：消息行头像经成员缓存解析（/api/channels/:id/members 对 dm 频道同样可用）
const dmChannelId = ref("");
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
// P1-11：历史加载失败原因（按 convKey），非空时空态分支显示错误态而非「还没有私信」
const loadError = computed(() => (convKey.value ? messageStore.loadError[convKey.value] : undefined));
const online = computed(() => uiStore.online);

const title = computed(() => peer.value?.displayName || peer.value?.handle || peerName.value || "私信");
const subtitle = computed(() => `@${peer.value?.handle || peerName.value || ""}`);
const isAgent = computed(() => peer.value?.type === "agent");
// 批次 C（P1.4）：DM 对端 agent 的 pending interrupt（channel = dm:@<senderHandle>）
const pendingInterrupts = computed(() => (isAgent.value ? interruptStore.forDm(peer.value?.id) : []));
// 页头头像：成员缓存行存在即以它为准（profile:update 就地回写，清空也同步为字母兜底），
// 未缓存时用 resolve 快照兜底
const peerAvatarUrl = computed(() => {
  const m = channelStore.membersByChannelId[dmChannelId.value]?.find(
    (mm) => String(mm.member_id) === String(peer.value?.id),
  );
  if (m) return m.avatar_url || undefined;
  return peer.value?.avatarUrl ?? undefined;
});

// React 版 useEffect([peerName, fetchHistory])：解析 dm:@peer → convKey，随后拉历史。
// fetchHistory 是 store 动作（引用稳定），故这里只 watch peerName。
watch(
  peerName,
  (name) => {
    if (!name) return;
    error.value = "";
    convKey.value = "";
    dmChannelId.value = ""; // 切会话先清——旧频道的成员缓存不能拿去解析新会话头像
    stickToBottom.value = true;
    apiGet<{ channelId: string; dmKey: string; peer: Peer }>("/api/channels/resolve", { target: "dm:@" + name })
      .then((d) => {
        peer.value = d.peer;
        convKey.value = d.dmKey;
        dmChannelId.value = d.channelId || "";
        if (d.channelId) void channelStore.fetchMembers(d.channelId);
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
  // F5：与 ChannelView 同口径——带附件也走离线队列（两段式：文件已传完，只排队 id），
  // 离线/失败不再直接丢，queued 待重发、failed 可重试/丢弃
  const trimmed = content.trim();
  if (!trimmed && attachmentIds.length === 0) return;
  messageStore.enqueuePending(convKey.value, trimmed, attachmentIds);
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

// P1-11：错误态重试（直接重拉历史；成功后 store 清 loadError，视图自动退回正常）
function retryLoadHistory() {
  if (!convKey.value) return;
  messageStore.fetchHistory(convKey.value).catch(() => {});
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
          <Avatar :name="title" :src="peerAvatarUrl" size="md" />
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
    <PendingInterruptBanner :items="pendingInterrupts" />

    <div v-if="error" class="flex flex-1 items-center justify-center p-4">
      <EmptyState icon="alert" title="无法打开私信" :description="error" />
    </div>

    <div v-else-if="messages.length === 0 && pending.length === 0" class="min-h-0 flex-1 overflow-y-auto p-4">
      <MessageSkeleton v-if="loading" />
      <!-- P1-11：加载失败显示错误态 + 重试，不再伪装成「还没有私信」 -->
      <EmptyState
        v-else-if="loadError"
        icon="alert"
        title="私信加载失败"
        :description="loadError"
        action-label="重新加载"
        @action="retryLoadHistory"
      />
      <EmptyState
        v-else
        icon="mail"
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
        :channel-id="dmChannelId"
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
