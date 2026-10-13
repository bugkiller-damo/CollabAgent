<script setup lang="ts">
import type { PendingInterruptSummary } from "@collabagent/shared";
import { ShieldAlert } from "@lucide/vue";
import { reactive } from "vue";
import { useRouter } from "vue-router";
import { buildDecision, buildResolveFrame, type DecisionButton, decisionButtons } from "../../lib/interrupt-decisions";
import { threadPath } from "../../lib/nav";
import { wsSend } from "../../lib/wsManager";
import { toast } from "../../stores/toastStore";

/**
 * 批次 C（P1.4）+ WP10：pending interrupt 审批门。bridge worker 的
 * turn.interrupt 经 daemon → server → `agent:interrupts` 快照到本组件。
 *
 * 语义：
 * - worker 声明了 options.decisions → 渲染对应按钮（批准/拒绝/回复），
 *   点击走 interrupt:resolve 结构化恢复（resume.decision + 可读文本）；
 * - 未声明 → 旧交互：在该会话正常回消息即按原样恢复（携 resumeToken），
 *   「驳回」= interrupt:dismiss 删 pending 记录，下条消息开全新回合；
 * - edit 决定一期不渲染按钮（协议层已通，UI 留给后续）；
 * - 行消失只靠下一份 agent:interrupts 快照——不做本地乐观移除；
 * - 线程绑定的 interrupt 在频道页另给「去线程回复」入口（文本回复必须
 *   落在其所属会话；结构化按钮自带 conversationId，任何语境都能点）。
 */
const props = defineProps<{
  items: PendingInterruptSummary[];
  /** 线程项「去线程回复」链接需要 serverId；不传入线程页/DM（本页即会话） */
  serverId?: string;
}>();

const router = useRouter();

/** 每条 interruptId 的本地 UI 态：展开的输入模式 + 文本 + 提交中 */
interface RowUi {
  mode: "reject" | "respond" | null;
  text: string;
  sending: boolean;
}
const ui = reactive<Record<string, RowUi>>({});
function stateOf(i: PendingInterruptSummary): RowUi {
  return (ui[i.interruptId] ??= { mode: null, text: "", sending: false });
}

function expiryLabel(i: PendingInterruptSummary): string {
  if (!i.expiresAt) return "";
  const ms = i.expiresAt - Date.now();
  if (ms <= 0) return "已过期";
  if (ms < 60_000) return "即将过期";
  const min = Math.ceil(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)} 小时后过期` : `${min} 分钟后过期`;
}

function dismiss(i: PendingInterruptSummary): void {
  wsSend({ type: "interrupt:dismiss", agentId: i.agentId, conversationId: i.conversationId });
  toast.success(`已驳回——@${i.agentName || i.agentId} 的下条消息将开新回合`);
}

function goThread(i: PendingInterruptSummary): void {
  if (!props.serverId || !i.channel || !i.threadId) return;
  void router.push(threadPath(props.serverId, i.channel, i.threadId));
}

/** 决定按钮：无输入的直接提交；reject/respond 展开/收起输入行 */
function onDecision(i: PendingInterruptSummary, b: DecisionButton): void {
  const s = stateOf(i);
  if (s.sending) return;
  if (!b.input) {
    submitDecision(i, b.type);
    return;
  }
  s.mode = s.mode === b.type ? null : (b.type as "reject" | "respond");
}

function submitDecision(i: PendingInterruptSummary, type: DecisionButton["type"]): void {
  const s = stateOf(i);
  const decision = buildDecision(type, s.text);
  if (!decision) return; // respond 空文本（按钮已禁用，这里兜底）
  s.sending = true;
  wsSend(buildResolveFrame(i, decision));
  // 行消失靠下一份 agent:interrupts 快照确认 pending 已消费——不做本地
  // 乐观移除。wsSend 掉线静默丢弃时 5s 复位允许重试，避免永久 loading。
  setTimeout(() => {
    s.sending = false;
  }, 5000);
}

/** 输入行的「提交」——v-if 保证 mode 非空 */
function submitCurrent(i: PendingInterruptSummary): void {
  const m = stateOf(i).mode;
  if (!m) return;
  submitDecision(i, m);
}
</script>

<template>
  <div v-if="items.length" class="border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900/50 dark:bg-amber-900/20">
    <div
      v-for="i in items"
      :key="i.interruptId"
      class="flex items-start gap-2 py-1.5 text-sm first:pt-0 last:pb-0"
    >
      <ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-amber-900 dark:text-amber-200">
          <span class="font-medium">@{{ i.agentName || i.agentId }}</span>
          请求审批：<span class="break-words">{{ i.prompt }}</span>
        </p>
        <ul v-if="i.options?.actions?.length" class="mt-1 space-y-0.5 text-xs text-amber-800/90 dark:text-amber-300/80">
          <li v-for="a in i.options.actions" :key="a.name" class="break-words">
            <span class="font-medium">· {{ a.name }}</span>
            <span v-if="a.argsPreview" class="ml-1 font-mono">{{ a.argsPreview }}</span>
            <span v-if="a.description" class="ml-1 opacity-80">{{ a.description }}</span>
          </li>
        </ul>
        <p class="mt-0.5 text-xs text-amber-700/80 dark:text-amber-300/70">
          <template v-if="decisionButtons(i).length">选择一个决定，或在会话中回复文本按原样恢复 · </template>
          <template v-else-if="i.threadId && serverId">线程中的回合 · </template>
          <template v-else>在下方回复即视为批准放行 · </template>
          {{ expiryLabel(i) }}
        </p>

        <!-- WP10：声明过 decisions → 结构化按钮组 -->
        <div v-if="decisionButtons(i).length" class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            v-for="b in decisionButtons(i)"
            :key="b.type"
            type="button"
            :disabled="stateOf(i).sending"
            class="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
            :class="{ 'bg-amber-100 dark:bg-amber-900/40': stateOf(i).mode === b.type }"
            @click="onDecision(i, b)"
          >
            {{ b.label }}
          </button>
          <button
            v-if="i.threadId && serverId"
            type="button"
            class="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
            @click="goThread(i)"
          >
            去线程回复
          </button>
          <span v-if="stateOf(i).sending" class="text-xs text-amber-700/80 dark:text-amber-300/70">已提交，等待 agent 恢复…</span>
        </div>
        <div v-if="stateOf(i).mode" class="mt-1.5 flex items-center gap-1.5">
          <input
            v-model="stateOf(i).text"
            type="text"
            :disabled="stateOf(i).sending"
            :placeholder="stateOf(i).mode === 'respond' ? '给 agent 的回复（必填）' : '拒绝原因（可选）'"
            class="min-w-0 flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-amber-900 placeholder:text-amber-500/70 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
            @keyup.enter="submitCurrent(i)"
          />
          <button
            type="button"
            :disabled="stateOf(i).sending || (stateOf(i).mode === 'respond' && !stateOf(i).text.trim())"
            class="shrink-0 rounded-md border border-amber-400 bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50 dark:border-amber-600 dark:bg-amber-900/50 dark:text-amber-100 dark:hover:bg-amber-900/70"
            @click="submitCurrent(i)"
          >
            提交
          </button>
          <button
            type="button"
            :disabled="stateOf(i).sending"
            class="shrink-0 rounded-md border border-amber-300 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
            @click="stateOf(i).mode = null"
          >
            取消
          </button>
        </div>
      </div>

      <!-- 未声明 decisions → 旧交互（文本回复即批准 + 驳回） -->
      <template v-if="!decisionButtons(i).length">
        <button
          v-if="i.threadId && serverId"
          type="button"
          class="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
          @click="goThread(i)"
        >
          去线程回复
        </button>
        <button
          type="button"
          title="驳回：作废该审批请求，下条消息开新回合"
          class="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
          @click="dismiss(i)"
        >
          驳回
        </button>
      </template>
    </div>
  </div>
</template>
