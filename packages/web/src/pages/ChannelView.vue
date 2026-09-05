<script setup lang="ts">
import type { Message } from "@collabagent/shared";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient, apiGet } from "../api";
import AgentProgressBar from "../components/agent/AgentProgressBar.vue";
import ChannelMembersPanel from "../components/channel/ChannelMembersPanel.vue";
import ChannelSettingsModal from "../components/channel/ChannelSettingsModal.vue";
import MessageComposer, { type ComposerAttachment } from "../components/chat/MessageComposer.vue";
import MessageRow from "../components/chat/MessageRow.vue";
import PendingRow from "../components/chat/PendingRow.vue";
import type { ListItem } from "../components/chat/types";
import VirtualMessageList from "../components/chat/VirtualMessageList.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import MessageSkeleton from "../components/skeleton/MessageSkeleton.vue";
import IconButton from "../components/ui/IconButton.vue";
import { useAgentStore, useChannelStore, useMessageStore, useUiStore } from "../stores";
import { toast } from "../stores/toastStore";

const VIRTUAL_THRESHOLD = 100;
const EMPTY_MSGS: Message[] = [];

const route = useRoute();
const router = useRouter();
const messageStore = useMessageStore();
const channelStore = useChannelStore();
const uiStore = useUiStore();
const agentStore = useAgentStore();

// ---- 路由参数（React: useParams / useLocation / useNavigate）----
const channelName = computed<string | undefined>(() => {
  const p = route.params.channelName;
  return Array.isArray(p) ? p[0] : p;
});
const target = computed(() => (channelName.value ? "#" + channelName.value : ""));
// vue-router 的 route.hash 含前导 "#"（与 React useLocation().hash 一致），去掉后作高亮消息 id
const highlightMsgId = computed(() => route.hash?.replace("#", "") || undefined);

// ---- store 派生（React: useMessageStore/useChannelStore selector）----
const messages = computed<Message[]>(() => {
  if (!target.value) return EMPTY_MSGS;
  return messageStore.messagesByTarget[target.value] || EMPTY_MSGS;
});
const loading = computed(() => messageStore.loading);
// P1-11：历史加载失败原因（按 target），非空时空态分支显示错误态而非「还没有消息」
const loadError = computed(() => (target.value ? messageStore.loadError[target.value] : undefined));
const currentChannel = computed<any>(() => channelStore.channels.find((c) => c.name === channelName.value));
const online = computed(() => uiStore.online);
const terminalAgent = computed(() => uiStore.terminalAgent);

// ---- 本地状态 ----
const showMembers = ref(false);
const showSettings = ref(false);
// 离线发送队列归 store 按 target 持久化（切频道/刷新不丢），这里只做派生
const pending = computed(() => (target.value ? messageStore.pendingByTarget[target.value] : undefined) || []);
const attachments = ref<ComposerAttachment[]>([]);
const droppedFiles = ref<File[] | null>(null);
const dragOver = ref(false);
const containerRef = ref<HTMLDivElement | null>(null);
const fetchedRef = ref<string | null>(null);
const highlightLoadedRef = ref(false);
const stickToBottom = ref(true);

const isPrivate = computed(() => {
  const c = currentChannel.value;
  return !!c && (c.type === "private" || c.visibility === "private");
});
const mentionScope = computed(() => ({
  channelId: currentChannel.value?.id,
  channelType: currentChannel.value?.type,
}));

// ---- Effect 1：切换频道时重置 + 拉历史（React useEffect([channelName, target, fetchHistory, setActiveChannel])）----
watch(
  channelName,
  (name) => {
    if (name && fetchedRef.value !== name) {
      fetchedRef.value = name;
      channelStore.setActiveChannel(name);
      attachments.value = [];
      messageStore.fetchHistory("#" + name).catch(() => {});
    }
  },
  { immediate: true },
);

watch(
  () => currentChannel.value?.id,
  (id) => {
    if (id) void channelStore.fetchMembers(id);
  },
  { immediate: true },
);

// ---- Effect 2：hash 高亮消息不在当前页时，按 id 前缀搜索并回填历史（React useEffect([highlightMsgId, messages, target, fetchHistory])）----
watch([highlightMsgId, messages, target], () => {
  const hid = highlightMsgId.value;
  if (!hid || highlightLoadedRef.value) return;
  if (messages.value.length === 0) return;
  const inPage = messages.value.find((m: any) => m.id === hid);
  if (inPage) {
    highlightLoadedRef.value = true;
    return;
  }
  apiGet<{ results: { id: string; seq: number }[] }>("/api/messages/search", { q: hid.slice(0, 8) })
    .then((r) => {
      const hit = r.results.find((x) => x.id === hid);
      if (hit) {
        messageStore.fetchHistory(target.value, { before: hit.seq + 1, limit: 50 }).catch(() => {});
        highlightLoadedRef.value = true;
      }
    })
    .catch(() => {});
});

function pinToBottom() {
  const el = containerRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onListScroll() {
  const el = containerRef.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

watch(channelName, () => {
  stickToBottom.value = true;
});

// 进频道 / 历史到达 / 新消息：钉在底部（用户上翻后不抢滚动）
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

// ---- 发送 / 离线队列 / 重试（队列逻辑已迁入 messageStore，本页只接线）----
async function handleSend(content: string, attachmentIds: string[]) {
  if (attachmentIds.length > 0) {
    // 附件路径保持现状：直发，失败 toast，不进离线队列
    try {
      await apiClient("/api/messages/send", { method: "POST", body: { target: target.value, content, attachmentIds } });
      messageStore.fetchHistory(target.value).catch(() => {});
      scrollToBottom();
    } catch (err) {
      console.error("Send with attachments failed", err);
      toast.error("发送失败，请重试");
      throw err;
    }
    return;
  }

  const trimmed = content.trim();
  if (!trimmed) return;

  // 纯文本：入队（带 clientNonce 幂等键）→ 离线仅排队，在线立即 flush
  messageStore.enqueuePending(target.value, trimmed);
  scrollToBottom();
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  messageStore.flushPending(target.value).catch(() => {});
}

function retrySend(tempId: string) {
  messageStore.retryPending(target.value, tempId).catch(() => {});
}

// P1-11：错误态重试（绕过 fetchedRef 守卫直接重拉；loading 期间空态分支自动显示骨架）
function retryLoadHistory() {
  if (!target.value) return;
  messageStore.fetchHistory(target.value).catch(() => {});
}

function discardPending(tempId: string) {
  messageStore.discardPending(target.value, tempId);
}

// ---- Effect 4：恢复在线时补发离线排队消息（React useEffect([online])）----
watch(
  online,
  (isOnline) => {
    if (!isOnline || !target.value) return;
    messageStore.flushPending(target.value).catch(() => {});
  },
  { immediate: true },
);

// ---- 派生：空态 / 是否虚拟列表 / 列表项 ----
const isEmpty = computed(() => messages.value.length === 0 && pending.value.length === 0);
const totalCount = computed(() => messages.value.length + pending.value.length);
const useVirtual = computed(() => totalCount.value > VIRTUAL_THRESHOLD);
const listItems = computed<ListItem[]>(() =>
  useVirtual.value
    ? [
        ...messages.value.map((m) => ({ kind: "msg" as const, data: m })),
        ...pending.value.map((p) => ({ kind: "pending" as const, data: p })),
      ]
    : [],
);

// ---- P1-12：≤100 条普通分支的搜索跳转高亮——对齐 VirtualMessageList 同款机制：
// 目标消息在列时滚动居中并给行打 is-highlighted（虚拟分支由 VirtualMessageList 内部自理）----
const didHighlightPlain = ref<string | undefined>(undefined);

function scrollToHighlight(hid: string) {
  const container = containerRef.value;
  const rowEl = container?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(hid)}"]`);
  if (!container || !rowEl) return;
  // 容器无 position:relative，offsetTop 依赖 offsetParent 链不可靠——用 getBoundingClientRect
  // 差值直接调 scrollTop，把目标行滚到视口垂直居中
  const delta = rowEl.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += delta - (container.clientHeight - rowEl.offsetHeight) / 2;
}

watch(
  [highlightMsgId, messages, useVirtual],
  ([hid, list, virtual]) => {
    if (virtual) return;
    if (!hid) {
      // 离开带 hash 的路由后重置：跨频道对同一 id 复跳可再次触发
      if (didHighlightPlain.value) didHighlightPlain.value = undefined;
      return;
    }
    if (didHighlightPlain.value === hid) return;
    if (!list.some((m) => m.id === hid)) return; // 不在当前页 → Effect 2 回填后 messages 变化再触发
    didHighlightPlain.value = hid;
    nextTick(() => {
      scrollToHighlight(hid);
      requestAnimationFrame(() => scrollToHighlight(hid));
    });
  },
  { flush: "post" },
);

// ---- 附件受控列表回写（React: onAttachmentsChange={setAttachments}）----
function setAttachments(next: ComposerAttachment[]) {
  attachments.value = next;
}

// ---- 拖拽文件 ----
function onDragOver(e: DragEvent) {
  e.preventDefault();
  dragOver.value = true;
}
function onDragLeave(e: DragEvent) {
  if (e.currentTarget === e.target) dragOver.value = false;
}
function onDropFiles(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) {
    droppedFiles.value = files;
    setTimeout(() => {
      droppedFiles.value = null;
    }, 50);
  }
}

// ---- 顶部操作按钮 ----
const channelAgentNames = computed(() => {
  const id = currentChannel.value?.id;
  const members = id ? channelStore.membersByChannelId[id] : undefined;
  return new Set((members ?? []).filter((m) => m.member_type === "agent").map((m) => m.handle));
});

function openAgentTerminal() {
  const names = channelAgentNames.value;
  const live = Object.values(agentStore.agents);
  const inChannel = names.size > 0 ? live.filter((a) => names.has(a.name)) : live;
  const working = inChannel.find((a) => a.status === "working" || (a.status as string) === "thinking");
  const fallback =
    (uiStore.terminalAgent && names.has(uiStore.terminalAgent) ? uiStore.terminalAgent : undefined) ||
    inChannel[0]?.name ||
    [...names][0];
  if (fallback) uiStore.openTerminal(fallback);
}

watch(
  () => uiStore.profileTarget,
  (t) => {
    if (t) showMembers.value = false;
  },
);

function closeMembers() {
  showMembers.value = false;
}
function closeSettings() {
  showSettings.value = false;
}
function goGeneral() {
  router.push("/channels/general");
}
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <div
      class="relative flex min-h-0 flex-1 flex-col"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDropFiles"
    >
      <div
        v-if="dragOver"
        class="pointer-events-none absolute inset-0 z-20 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-500/10"
      >
        <span class="font-medium text-blue-500">松开以上传文件</span>
      </div>

      <PageHeader :title="'#' + (channelName || '')" :subtitle="currentChannel?.description">
        <template #leading>
          <svg
            v-if="isPrivate"
            class="h-4 w-4 text-amber-500"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
            aria-label="私有频道"
          >
            <title>私有频道</title>
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
            />
          </svg>
        </template>

        <div class="flex items-center gap-1">
          <IconButton
            label="观察终端"
            tooltip="观察 Agent 终端"
            :class="terminalAgent ? 'text-blue-500' : ''"
            @click="openAgentTerminal"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
          </IconButton>
          <IconButton label="看板" tooltip="任务看板" @click="router.push('/tasks/' + channelName)">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
              />
            </svg>
          </IconButton>
          <IconButton
            label="成员"
            tooltip="成员"
            :class="showMembers ? 'text-blue-500' : ''"
            @click="showMembers = !showMembers"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.295-2.228-.837-3.244M15 19.128c.956.6 2.04.872 3.124.872M7.5 14.251c.956.6 2.04.872 3.124.872 1.085 0 2.169-.273 3.124-.872M7.5 14.251c.63.394 1.343.6 2.076.6h.017c.734 0 1.446-.206 2.076-.6m-4.17-.6a4.125 4.125 0 0 1-7.532 2.493 9.337 9.337 0 0 1 4.121-.952 9.38 9.38 0 0 1 2.625.372m9.94 3.198-1.807-1.626a4.125 4.125 0 0 0-5.512 0l-1.806 1.626M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
              />
            </svg>
          </IconButton>
          <IconButton v-if="currentChannel" label="频道设置" tooltip="频道设置" @click="showSettings = true">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0-2.206.037A9.968 9.968 0 0 0 12 21a9.969 9.969 0 0 0 7.855-3.476 4.5 4.5 0 0 0-2.206-.037 2.25 2.25 0 0 1-2.4-2.245 3 3 0 0 0-5.78-1.121Zm7.806-9.124a2.25 2.25 0 0 1 2.25 2.25v.75h1.125a2.25 2.25 0 0 1 2.25 2.25v2.25a2.25 2.25 0 0 1-2.25 2.25h-9.75c-.621 0-1.125.504-1.125 1.125v2.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
              />
            </svg>
          </IconButton>
        </div>
      </PageHeader>

      <AgentProgressBar :channel-name="channelName || ''" />

      <div v-if="isEmpty" class="min-h-0 flex-1 overflow-y-auto p-4">
        <MessageSkeleton v-if="loading" />
        <!-- P1-11：加载失败显示错误态 + 重试，不再伪装成「还没有消息」 -->
        <EmptyState
          v-else-if="loadError"
          icon="⚠️"
          title="消息加载失败"
          :description="loadError"
          action-label="重新加载"
          @action="retryLoadHistory"
        />
        <EmptyState v-else icon="💬" title="还没有消息" description="发送第一条消息，开启这个频道的对话吧" />
      </div>
      <VirtualMessageList
        v-else-if="useVirtual"
        :items="listItems"
        :channel-name="channelName"
        :highlight-msg-id="highlightMsgId"
        @retry="retrySend"
        @discard="discardPending"
      />
      <div v-else ref="containerRef" class="min-h-0 flex-1 space-y-1 overflow-y-auto p-4" @scroll.passive="onListScroll">
        <MessageRow
          v-for="(msg, idx) in messages"
          :key="msg.id"
          :msg="msg"
          :channel-name="channelName"
          :prev-msg="messages[idx - 1]"
          :is-highlighted="didHighlightPlain === msg.id"
          :data-msg-id="msg.id"
        />
        <PendingRow
          v-for="m in pending"
          :key="m.tempId"
          :item="m"
          @retry="retrySend"
          @discard="discardPending"
        />
      </div>

      <div class="border-t border-gray-200 p-4 dark:border-gray-700">
        <MessageComposer
          :placeholder="`发送消息到 #${channelName}... (@ 提及，可拖拽/粘贴文件)`"
          :attachments="attachments"
          :on-attachments-change="setAttachments"
          :on-send="handleSend"
          :dropped-files="droppedFiles"
          :mention-scope="mentionScope"
        />
      </div>
    </div>

    <ChannelMembersPanel v-if="showMembers && currentChannel" :channel-id="currentChannel.id" :on-close="closeMembers" />
    <ChannelSettingsModal
      v-if="showSettings && currentChannel"
      :channel="currentChannel"
      :on-close="closeSettings"
      :on-archived="goGeneral"
      :on-deleted="goGeneral"
    />
  </div>
</template>
