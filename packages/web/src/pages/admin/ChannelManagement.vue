<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiClient, apiGet, apiPatch, apiPost } from "../../api";
import ConfirmDialog from "../../components/ConfirmDialog.vue";
import PageHeader from "../../components/layout/PageHeader.vue";
import Button from "../../components/ui/Button.vue";
import Card from "../../components/ui/Card.vue";
import Input from "../../components/ui/Input.vue";

interface Channel {
  id: string;
  name: string;
  description: string | null;
  type: string;
  archived: boolean;
  role?: string | null;
}

const channels = ref<Channel[]>([]);
const loading = ref(true);
const showForm = ref(false);
const name = ref("");
const description = ref("");
const visibility = ref("public");
const msg = ref("");
const confirmDelete = ref<Channel | null>(null);

function load() {
  apiGet<{ channels: Channel[] }>("/api/channels")
    .then((d) => {
      channels.value = d.channels || [];
      loading.value = false;
    })
    .catch(() => {
      loading.value = false;
    });
}

onMounted(() => {
  load();
});

async function create() {
  const n = name.value.trim();
  if (!n) return;
  msg.value = "";
  try {
    await apiPost("/api/channels", { name: n, description: description.value.trim(), visibility: visibility.value });
    name.value = "";
    description.value = "";
    visibility.value = "public";
    showForm.value = false;
    load();
  } catch (e: any) {
    msg.value = e?.message || "创建失败";
  }
}

async function toggleArchive(c: Channel) {
  try {
    await apiPatch(`/api/channels/${c.id}`, { archived: !c.archived });
    load();
  } catch (e: any) {
    msg.value = e?.message || "操作失败";
  }
}

async function doDelete(c: Channel) {
  try {
    await apiClient(`/api/channels/${c.id}`, { method: "DELETE" });
    confirmDelete.value = null;
    load();
  } catch (e: any) {
    msg.value = e?.message || "删除失败";
    confirmDelete.value = null;
  }
}

function handleConfirmDelete() {
  if (confirmDelete.value) doDelete(confirmDelete.value);
}
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-4 p-4 sm:p-6">
    <PageHeader title="频道管理" back-to="/admin" :breadcrumb="[{ label: '管理后台', to: '/admin' }, { label: '频道管理' }]" />

    <div class="flex items-center justify-end">
      <Button size="sm" @click="showForm = !showForm">{{ showForm ? "取消" : "+ 新建频道" }}</Button>
    </div>

    <p v-if="msg" class="text-sm text-red-500">{{ msg }}</p>

    <Card v-if="showForm" class="space-y-3">
      <Input placeholder="频道名称（如 product）" :value="name" @input="name = ($event.target as HTMLInputElement).value" @keydown.enter="create" />
      <Input placeholder="描述（可选）" :value="description" @input="description = ($event.target as HTMLInputElement).value" />
      <select
        v-model="visibility"
        class="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
      >
        <option value="public">公开（所有成员可见）</option>
        <option value="private">私有（仅受邀成员）</option>
      </select>
      <Button size="sm" :disabled="!name.trim()" @click="create">创建</Button>
    </Card>

    <p v-if="loading" class="text-sm text-gray-500">加载中…</p>
    <Card v-else padding="none" class="divide-y divide-line">
      <div v-for="c in channels" :key="c.id" class="flex items-center gap-3 p-3">
        <span class="text-muted">{{ c.type === "private" ? "🔒" : "#" }}</span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-ink">
            {{ c.name }}
            <span v-if="c.archived" class="ml-2 text-xs text-muted">（已归档）</span>
          </p>
          <p v-if="c.description" class="truncate text-xs text-gray-500">{{ c.description }}</p>
        </div>
        <Button variant="ghost" size="sm" @click="toggleArchive(c)">{{ c.archived ? "取消归档" : "归档" }}</Button>
        <Button variant="ghost" size="sm" class="text-red-500 hover:text-red-600" @click="confirmDelete = c">删除</Button>
      </div>
      <p v-if="channels.length === 0" class="p-4 text-sm text-gray-500">暂无频道</p>
    </Card>

    <ConfirmDialog
      v-if="confirmDelete"
      :title="`删除频道 #${confirmDelete.name}？`"
      message="频道内的消息将一并删除，且无法恢复。"
      confirm-label="删除"
      danger
      @confirm="handleConfirmDelete"
      @cancel="confirmDelete = null"
    />
  </div>
</template>
