<script setup lang="ts">
import { ref } from "vue";
import { useChannelStore } from "../../stores";
import { apiClient } from "../../api";
import ConfirmDialog from "../ConfirmDialog.vue";
import Modal from "../ui/Modal.vue";
import Input from "../ui/Input.vue";
import Button from "../ui/Button.vue";

const props = defineProps<{
  channel: any;
  onClose: () => void;
  onArchived?: () => void;
  onDeleted?: () => void;
}>();

const channelStore = useChannelStore();

const description = ref(props.channel.description || "");
const visibility = ref<"public" | "private">(props.channel.type === "private" ? "private" : "public");
const error = ref("");
const saving = ref(false);
const confirm = ref<null | "delete" | "archive">(null);

async function handleSave() {
  saving.value = true;
  error.value = "";
  try {
    await channelStore.updateChannel(props.channel.id, { description: description.value.trim(), type: visibility.value });
    props.onClose();
  } catch (err: any) {
    error.value = err?.message || "保存失败";
    saving.value = false;
  }
}

async function handleDelete() {
  confirm.value = null;
  saving.value = true;
  error.value = "";
  try {
    await apiClient(`/api/channels/${props.channel.id}`, { method: "DELETE" });
    await channelStore.fetchChannels();
    props.onDeleted?.();
    props.onClose();
  } catch (err: any) {
    error.value = err?.message || "删除失败";
    saving.value = false;
  }
}

async function handleArchive() {
  confirm.value = null;
  saving.value = true;
  error.value = "";
  try {
    await channelStore.updateChannel(props.channel.id, { archived: true });
    props.onArchived?.();
    props.onClose();
  } catch (err: any) {
    error.value = err?.message || "归档失败";
    saving.value = false;
  }
}
</script>

<template>
  <Modal open @close="onClose">
    <h3 class="text-lg font-bold text-gray-900 dark:text-white">频道设置 · #{{ channel.name }}</h3>

    <div class="space-y-4">
      <div>
        <label class="mb-1 block text-sm text-gray-600 dark:text-gray-400">描述</label>
        <Input
          type="text"
          :value="description"
          @input="description = ($event.target as HTMLInputElement).value"
          placeholder="这个频道用来做什么？"
        />
      </div>

      <div>
        <label class="mb-1 block text-sm text-gray-600 dark:text-gray-400">可见性</label>
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

      <div class="flex items-center justify-between pt-2">
        <div class="flex gap-3">
          <Button
            :disabled="saving"
            variant="ghost"
            size="sm"
            class="text-amber-500 hover:text-amber-400"
            @click="confirm = 'archive'"
          >归档</Button>
          <Button
            :disabled="saving"
            variant="ghost"
            size="sm"
            class="text-red-500 hover:text-red-400"
            @click="confirm = 'delete'"
          >删除频道</Button>
        </div>
        <div class="flex gap-2">
          <Button variant="secondary" size="sm" @click="onClose">取消</Button>
          <Button :disabled="saving" :loading="saving" size="sm" @click="handleSave">
            {{ saving ? "保存中…" : "保存" }}
          </Button>
        </div>
      </div>
    </div>
  </Modal>

  <ConfirmDialog
    v-if="confirm === 'delete'"
    :title="`删除频道 #${channel.name}`"
    message="此操作不可撤销，频道内所有消息都会被永久删除。"
    confirm-label="删除"
    danger
    @confirm="handleDelete"
    @cancel="confirm = null"
  />
  <ConfirmDialog
    v-if="confirm === 'archive'"
    :title="`归档频道 #${channel.name}`"
    message="归档后将不可发送消息，但仍可查看历史。"
    confirm-label="归档"
    @confirm="handleArchive"
    @cancel="confirm = null"
  />
</template>
