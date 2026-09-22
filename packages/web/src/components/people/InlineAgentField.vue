<script setup lang="ts">
import { Check, Pencil, X } from "@lucide/vue";
import { nextTick, ref } from "vue";
import { apiPatch } from "../../api";
import { toast } from "../../stores/toastStore";
import Input from "../ui/Input.vue";

/**
 * Agent 资料行内编辑：值旁铅笔按钮 → 原地换成输入/下拉 + ✓✗，保存即 PATCH。
 * runtime/model 共用 agents.runtime_profile jsonb——提交时只发一个会把另一个
 * 重置成默认，故 extraPatch 让调用方捎带兄弟字段的当前值。
 */
const props = withDefaults(
  defineProps<{
    agentId: string;
    field: "displayName" | "description" | "runtime" | "model" | "avatarUrl" | "entrypoint";
    /** 展示值，也是编辑草稿的种子值 */
    value: string;
    /** 不可编辑（非自己的 agent）时只渲染 slot，不出铅笔 */
    editable?: boolean;
    kind?: "text" | "select";
    options?: { value: string; label: string }[];
    /**
     * 随 PATCH 捎带的兄弟字段当前值。批次 C（P1.3）起支持函数形态——
     * bridge 的 runtime/entrypoint/model 是耦合三元组（换 entrypoint 要按
     * 新 entrypoint 重算 runtime/model），回调拿到用户选定的 draft。
     */
    extraPatch?: Record<string, string> | ((draft: string) => Record<string, string>);
  }>(),
  { editable: true, kind: "text", options: undefined, extraPatch: undefined },
);

const emit = defineEmits<{ saved: [value: string] }>();

const editing = ref(false);
const saving = ref(false);
const draft = ref("");
const inputRef = ref<{ focus: () => void } | null>(null);
const selectRef = ref<HTMLSelectElement | null>(null);

async function start() {
  if (!props.editable || saving.value) return;
  draft.value = props.value;
  editing.value = true;
  await nextTick();
  (props.kind === "select" ? selectRef.value : inputRef.value)?.focus();
}

function cancel() {
  editing.value = false;
}

async function confirm() {
  if (saving.value) return;
  saving.value = true;
  try {
    const extra = typeof props.extraPatch === "function" ? props.extraPatch(draft.value) : props.extraPatch;
    await apiPatch(`/api/agents/${props.agentId}`, { ...extra, [props.field]: draft.value });
    editing.value = false;
    emit("saved", draft.value);
  } catch (err: any) {
    toast.error(err?.message || "保存失败");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="editable" class="flex min-w-0 items-start gap-1.5">
    <template v-if="!editing">
      <slot />
      <button
        type="button"
        title="编辑"
        aria-label="编辑"
        class="mt-0.5 shrink-0 text-muted transition-colors hover:text-gray-700 dark:hover:text-gray-200"
        @click="start"
      >
        <Pencil class="h-3.5 w-3.5" />
      </button>
    </template>
    <template v-else>
      <select
        v-if="kind === 'select'"
        ref="selectRef"
        v-model="draft"
        :disabled="saving"
        class="h-7 rounded-md border border-gray-300 bg-gray-100 px-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        @keydown.esc="cancel"
      >
        <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <Input
        v-else
        ref="inputRef"
        type="text"
        :value="draft"
        :disabled="saving"
        class="h-7 min-w-0 flex-1"
        @input="draft = ($event.target as HTMLInputElement).value"
        @keydown.enter="confirm"
        @keydown.esc="cancel"
      />
      <button
        type="button"
        title="保存"
        aria-label="保存"
        :disabled="saving"
        class="mt-0.5 shrink-0 text-green-600 transition-colors hover:text-green-700 disabled:opacity-50 dark:text-green-400"
        @click="confirm"
      >
        <Check class="h-4 w-4" />
      </button>
      <button
        type="button"
        title="取消"
        aria-label="取消"
        :disabled="saving"
        class="mt-0.5 shrink-0 text-muted transition-colors hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-200"
        @click="cancel"
      >
        <X class="h-4 w-4" />
      </button>
    </template>
  </div>
  <slot v-else />
</template>
