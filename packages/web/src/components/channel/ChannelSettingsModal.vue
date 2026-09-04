<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiClient, apiGet } from "../../api";
import { useChannelStore } from "../../stores";
import ConfirmDialog from "../ConfirmDialog.vue";
import Button from "../ui/Button.vue";
import Input from "../ui/Input.vue";
import Modal from "../ui/Modal.vue";

const props = defineProps<{
  channel: any;
  onClose: () => void;
  onArchived?: () => void;
  onDeleted?: () => void;
}>();

const channelStore = useChannelStore();

const description = ref(props.channel.description || "");
const visibility = ref<"public" | "private">(props.channel.type === "private" ? "private" : "public");
const managerTriageEnabled = ref(!!(props.channel.manager_triage_enabled ?? props.channel.managerTriageEnabled));
const hasManagerAgent = ref(false);
const canManage = computed(() => {
  const role = props.channel.role as string | undefined;
  return role === "owner" || role === "admin";
});
const error = ref("");
const saving = ref(false);
const confirm = ref<null | "delete" | "archive">(null);

onMounted(() => {
  apiGet<{ members: { member_type: string; is_manager?: boolean }[] }>(`/api/channels/${props.channel.id}/members`)
    .then((d) => {
      hasManagerAgent.value = (d.members || []).some((m) => m.member_type === "agent" && m.is_manager);
    })
    .catch(() => {});
});

async function handleSave() {
  saving.value = true;
  error.value = "";
  try {
    const patch: {
      description: string;
      type: "public" | "private";
      managerTriageEnabled?: boolean;
    } = {
      description: description.value.trim(),
      type: visibility.value,
    };
    if (canManage.value) patch.managerTriageEnabled = managerTriageEnabled.value;
    await channelStore.updateChannel(props.channel.id, patch);
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
    <h3 class="text-lg font-bold text-ink">频道设置 · #{{ channel.name }}</h3>

    <div class="space-y-4">
      <div>
        <label class="mb-1 block text-sm text-subtle">描述</label>
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

      <div>
        <label class="mb-1 flex items-center gap-2 text-sm text-subtle">
          <input
            type="checkbox"
            class="rounded border-gray-300"
            :checked="managerTriageEnabled"
            :disabled="!canManage || !hasManagerAgent"
            @change="managerTriageEnabled = ($event.target as HTMLInputElement).checked"
          />
          经理自动分诊
        </label>
        <p v-if="!hasManagerAgent" class="text-xs text-gray-500">先指定一名经理 agent，才能开启自动分诊。</p>
        <p v-else-if="!canManage" class="text-xs text-gray-500">仅频道所有者或管理员可更改此开关。</p>
        <p v-else class="text-xs text-gray-500">开启后，无人 @ agent 的顶层消息会交给频道经理分诊（自己回、派单或沉默）。</p>
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
