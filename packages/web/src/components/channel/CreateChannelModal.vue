<script setup lang="ts">
import { computed, ref } from "vue";
import { useChannelStore } from "../../stores";
import Button from "../ui/Button.vue";
import Input from "../ui/Input.vue";
import Modal from "../ui/Modal.vue";

const props = defineProps<{
  onClose: () => void;
  onCreated?: (name: string) => void;
}>();

const channelStore = useChannelStore();

const name = ref("");
const description = ref("");
const visibility = ref<"public" | "private">("public");
const error = ref("");
const saving = ref(false);

// 频道名格式化：小写、空格转连字符、移除非法字符、合并多个连字符
function formatChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9一-龥-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const formatted = computed(() => formatChannelName(name.value));
// 对齐 server P1.32 lower(name) 唯一索引口径：大小写变体也算重名
const exists = computed(() => channelStore.channels.some((c) => c.name.toLowerCase() === formatted.value));
const canSubmit = computed(() => formatted.value.length > 0 && !exists.value && !saving.value);

// server P1.32 收紧文案本地化（409 重名 / 400 超长）：客户端预检盖不住未加入的私有频道与大小写变体
function localizeCreateError(err: any): string {
  const msg = String(err?.message || "");
  if (err?.status === 409 || /already exists/i.test(msg)) return "同名频道已存在（含大小写变体或你未加入的私有频道）";
  if (/too long/i.test(msg)) return "频道名过长（上限 100 字符）";
  return msg || "创建失败";
}

async function handleSubmit() {
  if (!canSubmit.value) return;
  saving.value = true;
  error.value = "";
  try {
    await channelStore.createChannel({
      name: formatted.value,
      description: description.value.trim() || undefined,
      type: visibility.value,
    });
    props.onCreated?.(formatted.value);
    props.onClose();
  } catch (err: any) {
    error.value = localizeCreateError(err);
    saving.value = false;
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter") handleSubmit();
}
</script>

<template>
  <Modal open @close="onClose">
    <h3 class="text-lg font-bold text-ink">创建频道</h3>

    <div class="space-y-4">
      <div>
        <label class="mb-1 block text-sm text-subtle">频道名称</label>
        <Input
          type="text"
          autofocus
          maxlength="100"
          :value="name"
          @input="name = ($event.target as HTMLInputElement).value"
          @keydown="onKeyDown"
          placeholder="例如 产品讨论 / product"
        />
        <p v-if="formatted" class="mt-1 text-xs text-gray-500">
          频道标识：<span class="text-blue-500"># {{ formatted }}</span>
          <span v-if="exists" class="ml-2 text-red-400">该频道已存在</span>
        </p>
      </div>

      <div>
        <label class="mb-1 block text-sm text-subtle">描述（可选）</label>
        <Input
          type="text"
          :value="description"
          @input="description = ($event.target as HTMLInputElement).value"
          placeholder="这个频道用来做什么？"
        />
      </div>

      <div>
        <label class="mb-1 block text-sm text-subtle">可见性</label>
        <div class="flex gap-2">
          <button
            type="button"
            :class="[
              'flex-1 rounded-md border p-2 text-sm transition-colors',
              visibility === 'public'
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300',
            ]"
            @click="visibility = 'public'"
          >
            # 公开
          </button>
          <button
            type="button"
            :class="[
              'flex-1 rounded-md border p-2 text-sm transition-colors',
              visibility === 'private'
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300',
            ]"
            @click="visibility = 'private'"
          >
            🔒 私有
          </button>
        </div>
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <div class="flex justify-end gap-2 pt-2">
        <Button variant="secondary" size="sm" @click="onClose">取消</Button>
        <Button :disabled="!canSubmit" :loading="saving" size="sm" @click="handleSubmit">
          {{ saving ? "创建中…" : "创建" }}
        </Button>
      </div>
    </div>
  </Modal>
</template>
