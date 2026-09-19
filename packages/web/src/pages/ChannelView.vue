<script setup lang="ts">
import type { Message } from "@collabagent/shared";
import { ClipboardList, Lock, Settings, SquareTerminal, Users } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet } from "../api";
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
import { channelPath, lastChannelKey, scopedChannelKey, tasksPath } from "../lib/nav";
import { useAgentStore, useChannelStore, useMessageStore, useServerStore, useUiStore } from "../stores";

const VIRTUAL_THRESHOLD = 100;
const EMPTY_MSGS: Message[] = [];

const route = useRoute();
const router = useRouter();
const messageStore = useMessageStore();
const channelStore = useChannelStore();
const uiStore = useUiStore();
const agentStore = useAgentStore();
const serverStore = useServerStore();

// ---- 路由参数（React: useParams / useLocation / useNavigate）----
const channelName = computed<string | undefined>(() => {
  const p = route.params.channelName;
  return Array.isArray(p) ? p[0] : p;
});
// guild 化：URL 上的 serverId 优先（规范 /s/:serverId/channels/:name），
// 旧 /channels/* 路径回落活跃 server——本地 target key 统一 <serverId>:#name
const routeServerId = computed<string | undefined>(() => {
  const p = route.params.serverId;
  return (Array.isArray(p) ? p[0] : p) || serverStore.activeServerId || undefined;
});
const target = computed(() =>
  channelName.value ? scopedChannelKey(routeServerId.value ?? null, "#" + channelName.value) : "",
);
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
// 搜索跳转定位跟踪（按消息 id 记）：loaded = 已尝试过回填（防重复请求）；giveUp = 定位失败放弃
const highlightLoadedId = ref<string | undefined>(undefined);
const highlightGiveUpId = ref<string | undefined>(undefined);
const stickToBottom = ref(true);
// P1-12 普通分支已居中定位完成的高亮 id（声明提前：钉底 watcher 的抑制判断要用）
const didHighlightPlain = ref<string | undefined>(undefined);

const isPrivate = computed(() => {
  const c = currentChannel.value;
  return !!c && (c.type === "private" || c.visibility === "private");
});
const mentionScope = computed(() => ({
  channelId: currentChannel.value?.id,
  channelType: currentChannel.value?.type,
}));

// ---- Effect 1：切换频道时重置 + 拉历史（React useEffect([channelName, target, fetchHistory, setActiveChannel])）----
// guild 化：频道身份 = (serverId, name)——同名频道跨 server 是不同频道
watch(
  target,
  (t) => {
    if (t && channelName.value && fetchedRef.value !== t) {
      fetchedRef.value = t;
      channelStore.setActiveChannel(channelName.value);
      attachments.value = [];
      try {
        if (routeServerId.value) localStorage.setItem(lastChannelKey(routeServerId.value), channelName.value);
      } catch {
        /* ignore */
      }
      messageStore.fetchHistory(t).catch(() => {});
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

// ---- Effect 2：hash 高亮消息不在当前页时，locate 拿 seq 回填目标窗口（React useEffect([highlightMsgId, messages, target, fetchHistory])）----
// 修复前这里拿消息 id 前缀当关键词调 /api/messages/search——全文索引只覆盖 content，
// id 永不命中，回填实质是死代码，旧消息跳转永远停在最新位置。
watch([highlightMsgId, messages, target], () => {
  const hid = highlightMsgId.value;
  if (!hid || highlightLoadedId.value === hid) return;
  if (messages.value.length === 0) return;
  if (messages.value.some((m) => m.id === hid)) {
    highlightLoadedId.value = hid;
    return;
  }
  highlightLoadedId.value = hid; // 每个 id 只尝试一次：失败走 give-up 落底，不自动重试
  const targetAtCall = target.value;
  apiGet<{ seq: number; threadId: string | null }>(`/api/messages/${encodeURIComponent(hid)}/locate`)
    .then(async (r) => {
      // 线程回复不在主列表，无法定位——放弃，落底（与修复前行为一致）
      if (r.threadId) return giveUpHighlight(hid);
      // locate 在途时用户切了频道：seq 属于旧频道，不回填
      if (target.value !== targetAtCall) return;
      await messageStore.fetchHistory(targetAtCall, { before: r.seq + 1, limit: 50 }).catch(() => {});
      if (target.value !== targetAtCall) return;
      if (!(messageStore.messagesByTarget[targetAtCall] || []).some((m) => m.id === hid)) giveUpHighlight(hid);
    })
    .catch(() => giveUpHighlight(hid));
});

// 定位失败兜底：清掉 hash（高亮 watcher 随之复位、虚拟列表抑制解除）并钉底落最新——
// 与修复前「跳频道停最新」的行为一致，只是不再假装能定位
function giveUpHighlight(hid: string) {
  highlightGiveUpId.value = hid;
  if (route.hash === `#${hid}`) void router.replace({ path: route.path, query: route.query, hash: "" }).catch(() => {});
  stickToBottom.value = true;
  nextTick(() => {
    pinToBottom();
    requestAnimationFrame(pinToBottom);
  });
}

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
    // 高亮待定（目标未定位且未 give-up）时让位：否则这里的 rAF 钉底会盖掉随后的居中滚动
    const hid = highlightMsgId.value;
    if (hid && didHighlightPlain.value !== hid && highlightGiveUpId.value !== hid) return;
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
  const trimmed = content.trim();
  if (!trimmed && attachmentIds.length === 0) return;

  // F5：带附件消息统一走离线队列（pending 结构本就支持 attachmentIds）——
  // 两段式保持：composer 已把文件传完，这里只排队已上传的 id；
  // 离线不再直接丢，queued 待重发、failed 可重试/丢弃（与纯文本同口径）。
  messageStore.enqueuePending(target.value, trimmed, attachmentIds);
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
// （didHighlightPlain 已随上方 refs 提前声明——钉底 watcher 的抑制判断要用）

// hash 变化（新跳转 / give-up 清空）时重置定位跟踪——允许用户对同一 id 重试
watch(highlightMsgId, () => {
  highlightLoadedId.value = undefined;
  highlightGiveUpId.value = undefined;
});

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
    // 定位在历史位置：解除钉底——否则下一条新消息到达时钉底 watcher 会把视图拽回最新
    stickToBottom.value = false;
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
// 频道被归档/删除后的落点：按真实频道列表重解析——原频道已不在列表，
// 且新建 server 本无 general，硬编码会 404
function goGeneral() {
  const sid = routeServerId.value;
  if (sid) void channelStore.resolveLandingChannel(sid).then((name) => router.push(channelPath(sid, name)));
  else void router.push("/channels/general");
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
          <span v-if="isPrivate" class="text-amber-500" aria-label="私有频道">
            <Lock class="h-4 w-4" />
          </span>
        </template>

        <div class="flex items-center gap-1">
          <IconButton
            label="观察终端"
            tooltip="观察 Agent 终端"
            :class="terminalAgent ? 'text-blue-500' : ''"
            @click="openAgentTerminal"
          >
            <SquareTerminal class="h-5 w-5" />
          </IconButton>
          <IconButton
            label="看板"
            tooltip="任务看板"
            @click="router.push(routeServerId ? tasksPath(routeServerId, channelName) : '/tasks/' + channelName)"
          >
            <ClipboardList class="h-5 w-5" />
          </IconButton>
          <IconButton
            label="成员"
            tooltip="成员"
            :class="showMembers ? 'text-blue-500' : ''"
            @click="showMembers = !showMembers"
          >
            <Users class="h-5 w-5" />
          </IconButton>
          <IconButton v-if="currentChannel" label="频道设置" tooltip="频道设置" @click="showSettings = true">
            <Settings class="h-5 w-5" />
          </IconButton>
        </div>
      </PageHeader>

      <AgentProgressBar :channel-name="channelName || ''" />

      <div v-if="isEmpty" class="min-h-0 flex-1 overflow-y-auto p-4">
        <MessageSkeleton v-if="loading" />
        <!-- P1-11：加载失败显示错误态 + 重试，不再伪装成「还没有消息」 -->
        <EmptyState
          v-else-if="loadError"
          icon="alert"
          title="消息加载失败"
          :description="loadError"
          action-label="重新加载"
          @action="retryLoadHistory"
        />
        <EmptyState v-else icon="message" title="还没有消息" description="发送第一条消息，开启这个频道的对话吧" />
      </div>
      <VirtualMessageList
        v-else-if="useVirtual"
        :items="listItems"
        :channel-name="channelName"
        :channel-id="currentChannel?.id"
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
          :channel-id="currentChannel?.id"
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
