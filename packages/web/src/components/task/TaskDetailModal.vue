<script setup lang="ts">
import { ref, watch } from "vue";
import { apiGet, apiPost } from "../../api";
import { toast } from "../../stores/toastStore";
import Button from "../ui/Button.vue";
import Modal from "../ui/Modal.vue";
import Textarea from "../ui/Textarea.vue";

interface TaskSummary {
  id: string;
  task_number: number;
}

interface TaskDetail {
  id: string;
  content: string;
  task_number: number;
  task_status: string;
  task_assignee: string | null;
  assignee_handle: string | null;
  creator_name: string;
  sender_id: string;
  sender_type: string;
  created_at: string;
}

interface TaskEvent {
  id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  actor_name: string | null;
  created_at: string;
}

interface TaskComment {
  id: string;
  content: string;
  author_id: string;
  author_name: string | null;
  created_at: string;
}

const STATUS_META: Record<string, { label: string; badge: string; dot: string }> = {
  todo: { label: "待办", badge: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300", dot: "bg-gray-400" },
  in_progress: {
    label: "进行中",
    badge: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  in_review: {
    label: "审查中",
    badge: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  done: {
    label: "已完成",
    badge: "bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-400",
    dot: "bg-green-500",
  },
  closed: {
    label: "已关闭",
    badge: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
    dot: "bg-gray-500",
  },
};
const STATUS_ORDER = ["todo", "in_progress", "in_review", "done", "closed"];

const EVENT_DOT: Record<string, string> = {
  created: "bg-green-500",
  claimed: "bg-blue-500",
  unclaimed: "bg-gray-400",
  status_changed: "bg-amber-500",
};

const props = defineProps<{ task: TaskSummary; channel: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const detail = ref<TaskDetail | null>(null);
const events = ref<TaskEvent[]>([]);
const comments = ref<TaskComment[]>([]);
const loading = ref(false);
const newComment = ref("");
const sending = ref(false);

function statusLabel(s: string | null | undefined): string {
  return (s && STATUS_META[s]?.label) || s || "未知";
}

function statusBadge(s: string | null | undefined): string {
  return (s && STATUS_META[s]?.badge) || STATUS_META.todo!.badge;
}

function eventDot(action: string): string {
  return EVENT_DOT[action] || "bg-gray-400";
}

function fmtTime(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime())
    ? t
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function eventText(e: TaskEvent): string {
  switch (e.action) {
    case "created":
      return "创建了任务";
    case "claimed":
      return "认领了任务";
    case "unclaimed":
      return "取消了认领";
    case "status_changed":
      return e.from_status
        ? `将状态从 ${statusLabel(e.from_status)} 改为 ${statusLabel(e.to_status)}`
        : `将状态设为 ${statusLabel(e.to_status)}`;
    default:
      return e.action;
  }
}

async function loadDetail() {
  loading.value = true;
  try {
    const d = await apiGet<{ task: TaskDetail; events: TaskEvent[]; comments: TaskComment[] }>("/api/tasks/detail", {
      message_id: props.task.id,
    });
    detail.value = d.task;
    events.value = d.events || [];
    comments.value = d.comments || [];
  } catch (err: any) {
    toast.error(err?.message || "加载任务详情失败");
  } finally {
    loading.value = false;
  }
}

watch(() => props.task.id, loadDetail, { immediate: true });

async function moveTo(status: string) {
  if (!detail.value || status === detail.value.task_status) return;
  try {
    await apiPost("/api/tasks/update-status", {
      channel: "#" + props.channel,
      number: props.task.task_number,
      status,
    });
    await loadDetail();
    emit("changed");
  } catch (err: any) {
    toast.error(err?.message || "移动失败");
  }
}

async function claim() {
  try {
    await apiPost("/api/tasks/claim", { channel: "#" + props.channel, task_numbers: [props.task.task_number] });
    await loadDetail();
    emit("changed");
  } catch (err: any) {
    toast.error(err?.message || "认领失败");
  }
}

async function submitComment() {
  const text = newComment.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  try {
    const d = await apiPost<{ comment: TaskComment }>("/api/tasks/comments", {
      message_id: props.task.id,
      content: text,
    });
    comments.value = [...comments.value, d.comment];
    newComment.value = "";
  } catch (err: any) {
    toast.error(err?.message || "发表批注失败");
  } finally {
    sending.value = false;
  }
}

function close() {
  emit("close");
}
</script>

<template>
  <Modal :open="true" width-class="max-w-xl" class="flex !max-h-[85vh] !p-0 flex-col overflow-hidden" @close="close">
    <!-- 头部：编号 + 状态徽章 + 关闭 -->
    <div
      class="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-3.5 dark:border-gray-700/60"
    >
      <div class="flex items-center gap-2.5">
        <span class="text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          任务 #{{ task.task_number }}
        </span>
        <span
          v-if="detail"
          :class="['rounded-full px-2 py-0.5 text-[11px] font-medium leading-4', statusBadge(detail.task_status)]"
        >
          {{ statusLabel(detail.task_status) }}
        </span>
      </div>
      <button
        type="button"
        class="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
        aria-label="关闭"
        @click="close"
      >
        ✕
      </button>
    </div>

    <!-- 内容区（滚动） -->
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <p v-if="loading && !detail" class="py-10 text-center text-xs text-gray-400">加载中…</p>
      <template v-else-if="detail">
        <!-- 完整内容 -->
        <p class="whitespace-pre-wrap break-words text-[15px] leading-7 text-gray-900 dark:text-gray-100">
          {{ detail.content }}
        </p>

        <!-- 元信息 -->
        <div
          class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-lg bg-gray-50 px-4 py-3 text-[13px] dark:bg-gray-900/40"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-gray-400 dark:text-gray-500">创建人</span>
            <span class="truncate font-medium text-gray-700 dark:text-gray-300">{{ detail.creator_name }}</span>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-gray-400 dark:text-gray-500">负责人</span>
            <span v-if="detail.assignee_handle" class="truncate font-medium text-blue-600 dark:text-blue-400">
              @{{ detail.assignee_handle }}
            </span>
            <span v-else class="flex items-center gap-1.5">
              <span class="text-gray-400 dark:text-gray-500">未分配</span>
              <button type="button" class="font-medium text-blue-500 hover:underline" @click="claim">认领</button>
            </span>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-gray-400 dark:text-gray-500">创建时间</span>
            <span class="font-medium text-gray-700 dark:text-gray-300">{{ fmtTime(detail.created_at) }}</span>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-gray-400 dark:text-gray-500">状态</span>
            <select
              :value="detail.task_status"
              @change="moveTo(($event.target as HTMLSelectElement).value)"
              class="rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-xs font-medium text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >
              <option v-for="s in STATUS_ORDER" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
          </div>
        </div>

        <!-- 操作历史 -->
        <h4 class="mb-2.5 mt-6 text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          操作历史
        </h4>
        <ol v-if="events.length" class="relative space-y-3.5 border-l-2 border-gray-100 pl-4 dark:border-gray-700/60">
          <li v-for="e in events" :key="e.id" class="relative">
            <span
              :class="['absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white dark:ring-gray-800', eventDot(e.action)]"
            />
            <p class="text-[13px] leading-5 text-gray-700 dark:text-gray-300">
              <span class="font-semibold text-gray-900 dark:text-gray-100">{{ e.actor_name || "unknown" }}</span>
              {{ eventText(e) }}
            </p>
            <p class="mt-0.5 text-[11px] leading-4 text-gray-400 dark:text-gray-500">{{ fmtTime(e.created_at) }}</p>
          </li>
        </ol>
        <p v-else class="text-xs text-gray-400 dark:text-gray-500">暂无操作记录</p>

        <!-- 批注 -->
        <h4 class="mb-2.5 mt-6 text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          批注 <span class="font-normal normal-case tracking-normal">({{ comments.length }})</span>
        </h4>
        <div v-if="comments.length" class="space-y-2.5">
          <div v-for="c in comments" :key="c.id" class="rounded-lg bg-gray-50 px-3.5 py-2.5 dark:bg-gray-900/40">
            <div class="mb-1 flex items-baseline justify-between gap-2">
              <span class="text-xs font-semibold text-gray-800 dark:text-gray-200">{{ c.author_name || "unknown" }}</span>
              <span class="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{{ fmtTime(c.created_at) }}</span>
            </div>
            <p class="whitespace-pre-wrap break-words text-[13px] leading-6 text-gray-700 dark:text-gray-300">
              {{ c.content }}
            </p>
          </div>
        </div>
        <p v-else class="text-xs text-gray-400 dark:text-gray-500">暂无批注</p>
      </template>
    </div>

    <!-- 批注输入（固定底部） -->
    <div v-if="detail" class="shrink-0 border-t border-gray-100 px-5 py-3 dark:border-gray-700/60">
      <Textarea
        :value="newComment"
        @input="newComment = ($event.target as HTMLTextAreaElement).value"
        @keydown.enter.exact.prevent="submitComment"
        rows="2"
        placeholder="写下批注…（Enter 发送，Shift+Enter 换行）"
        class="!bg-gray-50 dark:!bg-gray-900/40"
      />
      <div class="mt-2 flex items-center justify-end">
        <Button size="sm" :loading="sending" :disabled="!newComment.trim()" @click="submitComment">发表批注</Button>
      </div>
    </div>
  </Modal>
</template>
