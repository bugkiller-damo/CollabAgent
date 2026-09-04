<script lang="ts">
import type { UploadedAttachment } from "../../api";

/**
 * 附件上传状态 —— 与 React 版 MessageComposer.tsx 导出的 ComposerAttachment 完全一致。
 * ChannelView / DmView 通过 `import type { ComposerAttachment } from "./MessageComposer.vue"`
 * 引用（对应 React 版 `import { type ComposerAttachment } from "../components/chat/MessageComposer"`）。
 */
export interface ComposerAttachment {
  tempId: string;
  name: string;
  status: "uploading" | "done" | "error";
  uploaded?: UploadedAttachment;
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uploadAttachment } from "../../api";
import { useMentionSuggest, type MentionScope } from "../../composables";
import { MAX_MESSAGE_CONTENT_LEN } from "../../lib/limits";
import { useUiStore } from "../../stores";
import MentionPopup from "./MentionPopup.vue";
import IconButton from "../ui/IconButton.vue";

const props = withDefaults(
  defineProps<{
    placeholder?: string;
    disabled?: boolean;
    /** 受控附件列表；不传则内部自管（对齐 React 版受控/非受控切换）。 */
    attachments?: ComposerAttachment[];
    onAttachmentsChange?: (attachments: ComposerAttachment[]) => void;
    onSend: (content: string, attachmentIds: string[]) => Promise<void>;
    /** 父组件拖拽/粘贴丢进来的外部文件（例如全局 drag-over 后由页面透传）。 */
    droppedFiles?: File[] | null;
    /** @ 提及候选的作用域：私有/DM 频道只列频道成员，公开频道为全量。 */
    mentionScope?: MentionScope;
  }>(),
  { disabled: false },
);

const draft = ref("");
const dragOver = ref(false);
const sending = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const internalAttachments = ref<ComposerAttachment[]>([]);

const isControlled = computed(() => props.attachments !== undefined);
const attachmentsList = computed<ComposerAttachment[]>(() =>
  isControlled.value ? props.attachments! : internalAttachments.value,
);

const { filtered, selectedIdx, visible, handleInput, handleKeyDown: mentionKD, insertMention: rawInsert } =
  useMentionSuggest(textareaRef, () => props.mentionScope);

const uiStore = useUiStore();

watch(
  () => uiStore.pendingMention,
  (h) => {
    if (!h) return;
    uiStore.consumeMention();
    const token = "@" + h + " ";
    const el = textareaRef.value;
    if (el) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + token + el.value.slice(end);
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      nativeSetter?.call(el, next);
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    } else {
      draft.value = (draft.value ? draft.value.replace(/\s*$/, " ") : "") + token;
    }
  },
);

const insertMention = (handle: string) => {
  // rawInsert 内部已同步 DOM value 并派发 input 事件（受控 textarea 由此同步 draft）；
  // 返回值兜底再同步一次，与 React 版 `if (newText !== undefined) setDraft(newText)` 对齐。
  const newText = rawInsert(handle);
  if (newText !== undefined) draft.value = newText;
};

const autoResize = (el: HTMLTextAreaElement) => {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
};

const setAttachments = (next: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) => {
  if (isControlled.value) {
    const prev = props.attachments!;
    props.onAttachmentsChange?.(typeof next === "function" ? next(prev) : next);
  } else {
    internalAttachments.value = typeof next === "function" ? next(internalAttachments.value) : next;
  }
};

const addAttachment = (file: File) => {
  const tempId = "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  if (file.size > 10 * 1024 * 1024) {
    setAttachments((a) => [...a, { tempId, name: file.name, status: "error" }]);
    return;
  }
  setAttachments((a) => [...a, { tempId, name: file.name, status: "uploading" }]);
  uploadAttachment(file)
    .then((uploaded) => setAttachments((a) => a.map((x) => (x.tempId === tempId ? { ...x, status: "done", uploaded } : x))))
    .catch(() => setAttachments((a) => a.map((x) => (x.tempId === tempId ? { ...x, status: "error" } : x))));
};

// React 版 useEffect([droppedFiles, addAttachment]) 会在挂载时跑一次（初始 null → 早退）；
// Vue 用 immediate watch 保持等价（含"挂载时已传入文件"的情况）。
watch(
  () => props.droppedFiles,
  (files) => {
    if (!files || files.length === 0) return;
    for (const file of files) addAttachment(file);
  },
  { immediate: true },
);

const handleFiles = (files: FileList | File[] | null) => {
  if (!files) return;
  for (const file of Array.from(files)) addAttachment(file);
};

const removeAttachment = (tempId: string) => setAttachments((a) => a.filter((x) => x.tempId !== tempId));

const canSend = computed(
  () =>
    !props.disabled &&
    !sending.value &&
    !attachmentsList.value.some((a) => a.status === "uploading") &&
    (draft.value.trim().length > 0 || attachmentsList.value.some((a) => a.status === "done")),
);

const doSend = async () => {
  const content = draft.value.trim();
  if (attachmentsList.value.some((a) => a.status === "uploading")) return;
  const attachmentIds = attachmentsList.value
    .filter((a) => a.status === "done" && a.uploaded)
    .map((a) => a.uploaded!.attachmentId);
  if (!content && attachmentIds.length === 0) return;

  sending.value = true;
  try {
    await props.onSend(content, attachmentIds);
    draft.value = "";
    setAttachments([]);
    const el = textareaRef.value;
    if (el) el.style.height = "auto";
  } catch {
    // 失败由 onSend 侧自行提示（toast/横幅），草稿保留不清空（W-A3：吞掉异常防 unhandled rejection）
  } finally {
    sending.value = false;
  }
};

const onKeyDown = (e: KeyboardEvent) => {
  mentionKD(e);
  if (!visible.value && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
};

const onChange = (e: Event) => {
  const el = e.target as HTMLTextAreaElement;
  draft.value = el.value;
  handleInput(e);
  autoResize(el);
};

const onPaste = (e: ClipboardEvent) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) {
    e.preventDefault();
    handleFiles(files);
  }
};

const onFileChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  handleFiles(input.files);
  input.value = "";
};

const openFilePicker = () => fileInputRef.value?.click();

const onDragOver = (e: DragEvent) => {
  e.preventDefault();
  dragOver.value = true;
};

const onDragLeave = (e: DragEvent) => {
  if (e.currentTarget === e.target) dragOver.value = false;
};

const onDrop = (e: DragEvent) => {
  e.preventDefault();
  dragOver.value = false;
  handleFiles(e.dataTransfer?.files ?? null);
};
</script>

<template>
  <div class="relative" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <div
      v-if="dragOver"
      class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-500/10"
    >
      <span class="font-medium text-blue-500">松开以上传文件</span>
    </div>

    <MentionPopup :items="filtered" :selected-idx="selectedIdx" @select="insertMention" />

    <div v-if="attachmentsList.length > 0" class="mb-2 flex flex-wrap gap-2">
      <div
        v-for="a in attachmentsList"
        :key="a.tempId"
        class="flex items-center gap-1.5 rounded bg-gray-200 px-2 py-1 text-xs dark:bg-gray-700"
      >
        <span class="max-w-[140px] truncate text-gray-700 dark:text-gray-200">{{ a.name }}</span>
        <span v-if="a.status === 'uploading'" class="text-gray-400">上传中…</span>
        <span v-if="a.status === 'error'" class="text-red-500">失败</span>
        <button
          type="button"
          class="text-gray-400 hover:text-red-500"
          aria-label="移除附件"
          @click="removeAttachment(a.tempId)"
        >
          ✕
        </button>
      </div>
    </div>

    <div class="flex items-end gap-2">
      <input ref="fileInputRef" type="file" multiple class="hidden" @change="onFileChange" />

      <IconButton label="上传文件" tooltip="上传文件" :disabled="disabled || sending" @click="openFilePicker">
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 0 1-2.25-2.25V9m12.841 2.091a2.25 2.25 0 0 1 3.18 0l2.87 2.87"
          />
        </svg>
      </IconButton>

      <textarea
        ref="textareaRef"
        :value="draft"
        :placeholder="placeholder"
        :rows="1"
        :disabled="disabled || sending"
        :maxlength="MAX_MESSAGE_CONTENT_LEN"
        class="min-h-[2.5rem] w-full resize-none rounded-md border border-gray-300 bg-gray-100 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder:text-gray-500 disabled:cursor-not-allowed disabled:opacity-50"
        @input="onChange"
        @keydown="onKeyDown"
        @paste="onPaste"
      />

      <button
        type="button"
        :disabled="!canSend"
        aria-label="发送"
        class="mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors"
        :class="
          canSend
            ? 'bg-blue-600 text-white hover:bg-blue-500'
            : 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500'
        "
        @click="doSend"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"
          />
        </svg>
      </button>
    </div>

    <div class="mt-1 flex justify-between text-xs text-muted">
      <span>Enter 发送 · Shift+Enter 换行 · @ 提及 · 支持拖拽/粘贴上传</span>
      <span v-if="draft.length > 0">{{ draft.length }}/{{ MAX_MESSAGE_CONTENT_LEN }}</span>
    </div>
  </div>
</template>
