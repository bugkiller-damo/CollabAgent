<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { apiClient } from "../../api";
import { formatTime } from "../../lib/formatTime";
import { useAuthStore, useMessageStore } from "../../stores";
import { toast } from "../../stores/toastStore";
import ConfirmDialog from "../ConfirmDialog.vue";
import AttachmentView from "./AttachmentView.vue";
import LinkPreview from "./LinkPreview.vue";
import MarkdownContent from "./MarkdownContent.vue";

const EMOJI_CHOICES = ["👍", "❤️", "😂", "🎉", "🤔", "👀"];

// 消息高亮闪烁动画（淡黄色背景 → 渐变为透明，3s 完成）。
// React 版在模块作用域注入一次 <style>；这里同样用 id 守卫保证只注入一次。
const highlightStyleId = "msg-highlight-style";
if (typeof document !== "undefined" && !document.getElementById(highlightStyleId)) {
  const s = document.createElement("style");
  s.id = highlightStyleId;
  s.textContent = `
    @keyframes msgHighlight {
      0% { background-color: rgba(234, 179, 8, 0.25); }
      100% { background-color: transparent; }
    }
    .animate-highlight {
      animation: msgHighlight 3s ease-out forwards;
    }
  `;
  document.head.appendChild(s);
}

const props = defineProps<{
  msg: any;
  channelName?: string;
  isHighlighted?: boolean;
  prevMsg?: any;
}>();

const router = useRouter();
const authStore = useAuthStore();
const messageStore = useMessageStore();

const editing = ref(false);
const editText = ref(props.msg.content || "");
const editTextareaRef = ref<HTMLTextAreaElement | null>(null);
const confirmDelete = ref(false);
const emojiPickerOpen = ref(false);
const converting = ref(false);

const currentUserId = computed(() => authStore.user?.id);
const replyCount = computed(() => props.msg._replyCount ?? props.msg.replyCount ?? props.msg.reply_count ?? 0);
const isOwn = computed(
  () => !!currentUserId.value && props.msg.senderId && String(props.msg.senderId) === String(currentUserId.value),
);
const edited = computed(() => props.msg.editedAt || props.msg.edited_at);
const deleted = computed(() => props.msg.deleted);
const firstUrl = computed(() => (props.msg.content?.match(/https?:\/\/[^\s<>()]+/) || [])[0]);
const reactions = computed<{ emoji: string; userIds: string[] }[]>(() => props.msg.reactions || []);
const dispatchKind = computed(() =>
  props.msg.content?.startsWith("📋")
    ? "派发"
    : props.msg.content?.startsWith("✅")
      ? "回报"
      : props.msg.content?.startsWith("🚫")
        ? "撤回"
        : null,
);

// 紧凑模式：与上一条为同一发送者，且时间差在 5 分钟内
const timeDiffMin = computed(() => {
  const prev = props.prevMsg;
  if (!prev) return Infinity;
  return (
    Math.abs(
      new Date(props.msg.time || props.msg.createdAt).getTime() - new Date(prev.time || prev.createdAt).getTime(),
    ) / 60000
  );
});
const compact = computed(
  () =>
    !!props.prevMsg &&
    props.prevMsg.senderId === props.msg.senderId &&
    timeDiffMin.value < 5 &&
    !dispatchKind.value &&
    !props.prevMsg.deleted,
);

// DM 会话的 channelName 是 "@handle" 格式（DmView convKey），转任务按钮只在频道上下文显示
const isChannel = computed(() => !!props.channelName && !props.channelName.startsWith("@"));

function startEdit() {
  editText.value = props.msg.content || "";
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editText.value = props.msg.content || "";
}

async function saveEdit() {
  const text = editText.value.trim();
  if (!text || text === props.msg.content) {
    editing.value = false;
    return;
  }
  try {
    await messageStore.editMessage(props.msg.id, text);
    editing.value = false;
  } catch {
    // keep editing open on failure
  }
}

async function handleDelete() {
  confirmDelete.value = false;
  try {
    await messageStore.deleteMessage(props.msg.id);
    toast.success("消息已删除");
  } catch (err: any) {
    toast.error(err?.message || "删除失败");
  }
}

async function handleConvertToTask() {
  if (converting.value) return;
  converting.value = true;
  try {
    const data = await apiClient<{ task: { task_number: number } }>("/api/tasks/from-message", {
      method: "POST",
      body: { message_id: props.msg.id },
    });
    messageStore.applyMessageTask(props.msg.id, data.task.task_number);
    toast.success(`已转为任务 #${data.task.task_number}，可在看板查看`);
  } catch (err: any) {
    toast.error(err?.message || "转任务失败");
  } finally {
    converting.value = false;
  }
}

function hasMyReaction(r: { emoji: string; userIds: string[] }): boolean {
  return !!currentUserId.value && r.userIds.includes(String(currentUserId.value));
}

async function handleReactionClick(emoji: string) {
  if (!currentUserId.value) return;
  const existing = reactions.value.find((r) => r.emoji === emoji);
  const hasMy = existing?.userIds.includes(String(currentUserId.value));
  try {
    if (hasMy) {
      await messageStore.removeReaction(props.msg.id, emoji, String(currentUserId.value));
    } else {
      await messageStore.addReaction(props.msg.id, emoji, String(currentUserId.value));
    }
  } catch (err: any) {
    toast.error(err?.message || "操作失败");
  }
}

function copyContent() {
  navigator.clipboard.writeText(props.msg.content || "");
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    saveEdit();
  } else if (e.key === "Escape") {
    cancelEdit();
  }
}

// 对齐 React 编辑框的 autoFocus：进入编辑态后聚焦 textarea
watch(editing, (val) => {
  if (val) nextTick(() => editTextareaRef.value?.focus());
});

function goToThread() {
  router.push(`/channels/${props.channelName}/${props.msg.id}`);
}
</script>

<template>
  <div
    :class="[
      'group flex gap-3 hover:bg-gray-100 dark:hover:bg-gray-800/50 p-2 rounded relative',
      isHighlighted ? 'animate-highlight' : '',
      dispatchKind
        ? 'border-l-2 border-amber-400 dark:border-amber-600 bg-amber-50/40 dark:bg-amber-900/10'
        : '',
    ]"
  >
    <div v-if="compact" class="w-8 shrink-0" />
    <div
      v-else
      class="w-8 h-8 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white"
    >
      {{ (msg.senderName || "?")[0] }}
    </div>

    <div class="min-w-0 flex-1">
      <div v-if="!compact" class="flex items-baseline gap-2">
        <span class="font-semibold text-gray-900 dark:text-white text-sm">
          {{ msg.senderName || msg.senderId || "Unknown" }}
        </span>
        <span class="text-gray-500 text-xs" :title="new Date(msg.time || msg.createdAt).toLocaleString()">
          {{ formatTime(msg.time || msg.createdAt) }}
        </span>
        <span v-if="edited" class="text-gray-400 text-xs">(已编辑)</span>
        <span v-if="deleted" class="text-gray-400 text-xs italic">(已删除)</span>
        <span
          v-if="dispatchKind"
          class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300"
        >
          任务{{ dispatchKind }}
        </span>
      </div>

      <div v-if="editing" class="mt-1">
        <textarea
          ref="editTextareaRef"
          v-model="editText"
          rows="2"
          class="w-full p-2 rounded bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 text-sm resize-none"
          @keydown="onEditKeydown"
        />
        <div class="text-xs text-gray-400 mt-0.5">
          Enter 保存 · Esc 取消
          <button @click="saveEdit" class="ml-2 text-blue-500 hover:underline">保存</button>
          <button @click="cancelEdit" class="ml-2 hover:underline">取消</button>
        </div>
      </div>

      <template v-else>
        <p v-if="deleted" class="text-gray-400 italic text-sm mt-0.5">此消息已删除</p>
        <template v-else>
          <MarkdownContent v-if="msg.content" :content="msg.content" />
          <AttachmentView v-if="msg.attachments && msg.attachments.length > 0" :attachments="msg.attachments" />
          <LinkPreview v-if="firstUrl" :url="firstUrl" />
        </template>

        <!-- Reactions chips -->
        <div v-if="reactions.length > 0" class="flex flex-wrap gap-1 mt-1">
          <button
            v-for="r in reactions"
            :key="r.emoji"
            @click="handleReactionClick(r.emoji)"
            :class="[
              'text-xs px-1.5 py-0.5 rounded border',
              hasMyReaction(r)
                ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-300 dark:border-blue-700'
                : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
              'hover:opacity-80',
            ]"
            :title="`${r.userIds.length} 人`"
          >
            {{ r.emoji }} {{ r.userIds.length }}
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-1 mt-1 relative">
          <button
            @click="goToThread"
            class="text-gray-500 hover:text-blue-400 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            💬 {{ replyCount > 0 ? replyCount + " 条回复" : "回复" }}
          </button>

          <template v-if="isChannel && !deleted">
            <span
              v-if="msg.task_number != null"
              class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
            >
              📋 任务 #{{ msg.task_number }}
            </span>
            <button
              v-else
              @click="handleConvertToTask"
              :disabled="converting"
              class="text-gray-500 hover:text-blue-500 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity disabled:opacity-50"
              title="把这条消息转为看板任务"
            >
              {{ converting ? "转换中…" : "📋 转任务" }}
            </button>
          </template>

          <button
            @click="copyContent"
            class="text-gray-500 hover:text-gray-900 dark:hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
          >
            复制
          </button>

          <template v-if="isOwn && !deleted">
            <button
              @click="startEdit"
              class="text-gray-500 hover:text-gray-900 dark:hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
            >
              编辑
            </button>
            <button
              @click="confirmDelete = true"
              class="text-red-500 hover:text-red-600 text-xs px-1.5 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/30 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
              title="删除消息"
            >
              🗑 删除
            </button>
          </template>

          <template v-if="!deleted">
            <button
              @click="emojiPickerOpen = !emojiPickerOpen"
              class="text-gray-500 hover:text-yellow-400 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
            >
              😀
            </button>
            <div
              v-if="emojiPickerOpen"
              class="absolute right-0 top-6 z-10 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-1 flex gap-0.5 animate-scale-in origin-top-right"
            >
              <button
                v-for="e in EMOJI_CHOICES"
                :key="e"
                @click="handleReactionClick(e); emojiPickerOpen = false"
                class="text-lg w-7 h-7 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                {{ e }}
              </button>
            </div>
          </template>
        </div>
      </template>
    </div>

    <ConfirmDialog
      v-if="confirmDelete"
      title="删除消息"
      message="确认删除这条消息？此操作不可撤销。"
      confirm-label="删除"
      danger
      @confirm="handleDelete"
      @cancel="confirmDelete = false"
    />
  </div>
</template>
