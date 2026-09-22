<script setup lang="ts">
import type { PendingInterruptSummary } from "@collabagent/shared";
import { ShieldAlert } from "@lucide/vue";
import { useRouter } from "vue-router";
import { threadPath } from "../../lib/nav";
import { wsSend } from "../../lib/wsManager";
import { toast } from "../../stores/toastStore";

/**
 * 批次 C（P1.4）：pending interrupt 审批门。bridge worker 的 turn.interrupt
 * 经 daemon → server → `agent:interrupts` 快照到本组件。
 *
 * 语义：
 * - 「批准」= 在该会话正常回一条消息——daemon 派发时自动携 resumeToken 恢复
 *   （token 一次性，agentId+conversationId 定位），无需单独 API；
 * - 「驳回」= interrupt:dismiss 控制帧（server 校验属主后路由回托管 daemon）
 *   删 pending 记录，下条消息开全新回合；
 * - 线程绑定的 interrupt 在频道页只给「去线程回复」入口（approve 必须发生在
 *   其所属会话，conversationId 不同不发）。
 */
const props = defineProps<{
  items: PendingInterruptSummary[];
  /** 线程项「去线程回复」链接需要 serverId；不传入线程页/DM（本页即会话） */
  serverId?: string;
}>();

const router = useRouter();

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
</script>

<template>
  <div v-if="items.length" class="border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900/50 dark:bg-amber-900/20">
    <div
      v-for="i in items"
      :key="i.conversationId"
      class="flex items-start gap-2 py-1.5 text-sm first:pt-0 last:pb-0"
    >
      <ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-amber-900 dark:text-amber-200">
          <span class="font-medium">@{{ i.agentName || i.agentId }}</span>
          请求审批：<span class="break-words">{{ i.prompt }}</span>
        </p>
        <p class="mt-0.5 text-xs text-amber-700/80 dark:text-amber-300/70">
          <template v-if="i.threadId && serverId">线程中的回合 · </template>
          <template v-else>在下方回复即视为批准放行 · </template>
          {{ expiryLabel(i) }}
        </p>
      </div>
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
    </div>
  </div>
</template>
