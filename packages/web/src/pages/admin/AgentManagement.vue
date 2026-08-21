<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { apiClient, apiGet, apiPatch, apiPost } from "../../api";
import AgentPatrolPanel from "../../components/admin/AgentPatrolPanel.vue";
import OrgMembersPanel from "../../components/admin/OrgMembersPanel.vue";
import ConfirmDialog from "../../components/ConfirmDialog.vue";
import EmptyState from "../../components/EmptyState.vue";
import PageHeader from "../../components/layout/PageHeader.vue";
import AgentCardSkeleton from "../../components/skeleton/AgentCardSkeleton.vue";
import Avatar from "../../components/ui/Avatar.vue";
import Button from "../../components/ui/Button.vue";
import Card from "../../components/ui/Card.vue";
import Input from "../../components/ui/Input.vue";
import { useUiStore } from "../../stores";
import { toast } from "../../stores/toastStore";

interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string;
  status: string;
  runtime: string;
  model: string;
  isOnline: boolean;
  avatar_url?: string;
}

const uiStore = useUiStore();

const agents = ref<Agent[]>([]);
const loading = ref(true);
const showForm = ref(false);
const editId = ref<string | null>(null);
const name = ref("");
const displayName = ref("");
const description = ref("");
const avatarUrl = ref("");
const runtime = ref("claude");
const model = ref("sonnet");
const confirmDelete = ref<Agent | null>(null);
// T2:当前展开巡检面板的 agent(面板复用 /internal/agent/:id/reminders 路由族)
const patrolAgent = ref<Agent | null>(null);

async function loadAgents() {
  try {
    const data = await apiGet<{ agents: Agent[] }>("/api/agents");
    agents.value = data.agents || [];
    loading.value = false;
  } catch {
    loading.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  loadAgents();
  pollTimer = setInterval(loadAgents, 5000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function resetForm() {
  showForm.value = false;
  editId.value = null;
  name.value = "";
  displayName.value = "";
  description.value = "";
  avatarUrl.value = "";
  runtime.value = "claude";
  model.value = "sonnet";
}

function openCreate() {
  editId.value = null;
  name.value = "";
  displayName.value = "";
  description.value = "";
  avatarUrl.value = "";
  runtime.value = "claude";
  model.value = "sonnet";
  showForm.value = true;
}

function openEdit(a: Agent) {
  editId.value = a.id;
  name.value = a.name;
  displayName.value = a.display_name || "";
  description.value = a.description || "";
  avatarUrl.value = a.avatar_url || "";
  runtime.value = a.runtime || "claude";
  model.value = a.model || "sonnet";
  showForm.value = true;
}

async function handleSubmit() {
  if (!name.value.trim()) return;
  try {
    const payload = {
      name: name.value,
      displayName: displayName.value,
      description: description.value,
      avatarUrl: avatarUrl.value,
      runtime: runtime.value,
      model: model.value,
    };
    if (editId.value) {
      await apiPatch(`/api/agents/${editId.value}`, payload);
    } else {
      await apiPost("/api/agents", payload);
    }
    resetForm();
    loadAgents();
  } catch (err: any) {
    toast.error(err?.message || "保存失败");
  }
}

async function handleDelete(a: Agent) {
  confirmDelete.value = null;
  try {
    await apiClient(`/api/agents/${a.id}`, { method: "DELETE" });
    loadAgents();
  } catch (err: any) {
    toast.error(err?.message || "删除失败");
  }
}

function handleConfirmDelete() {
  if (confirmDelete.value) handleDelete(confirmDelete.value);
}
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
    <PageHeader title="Agent 管理" back-to="/admin" :breadcrumb="[{ label: '管理后台', to: '/admin' }, { label: 'Agent 管理' }]" />

    <div class="flex items-center justify-end">
      <Button size="sm" @click="openCreate">+ 创建 Agent</Button>
    </div>

    <OrgMembersPanel />

    <Card v-if="showForm" class="space-y-3">
      <h3 class="font-semibold text-gray-900 dark:text-white">{{ editId ? "编辑 Agent" : "创建新 Agent" }}</h3>
      <Input type="text" placeholder="Agent 名称 (如 slock-backend)" :value="name" @input="name = ($event.target as HTMLInputElement).value" />
      <Input type="text" placeholder="显示名称" :value="displayName" @input="displayName = ($event.target as HTMLInputElement).value" />
      <Input type="text" placeholder="描述（也作为它的角色设定）" :value="description" @input="description = ($event.target as HTMLInputElement).value" />
      <Input type="text" placeholder="头像 URL（可选）" :value="avatarUrl" @input="avatarUrl = ($event.target as HTMLInputElement).value" />
      <div class="flex gap-2">
        <select
          v-model="runtime"
          class="rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          <option value="claude">Claude</option>
        </select>
        <select
          v-model="model"
          class="rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
          <option value="haiku">Haiku</option>
        </select>
      </div>
      <div class="flex gap-2">
        <Button size="sm" @click="handleSubmit">{{ editId ? "保存" : "创建" }}</Button>
        <Button variant="secondary" size="sm" @click="resetForm">取消</Button>
      </div>
    </Card>

    <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Card v-for="a in agents" :key="a.id" padding="md" class="flex items-center gap-4">
        <Avatar :name="a.name" :src="a.avatar_url" size="lg" :online="a.isOnline" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-gray-900 dark:text-white">@{{ a.name }}</span>
            <span v-if="a.display_name && a.display_name !== a.name" class="text-sm text-gray-500">{{ a.display_name }}</span>
            <span
              :class="[
                'rounded px-1.5 py-0.5 text-xs',
                a.isOnline
                  ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                  : 'bg-gray-200 text-gray-500 dark:bg-gray-700',
              ]"
            >
              {{ a.isOnline ? "在线" : "离线" }}
            </span>
          </div>
          <p class="truncate text-sm text-gray-500 dark:text-gray-400">{{ a.description || "（无描述）" }}</p>
          <p class="text-xs text-gray-400 dark:text-gray-500">{{ a.runtime }} / {{ a.model }}</p>
        </div>
        <div class="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" @click="patrolAgent = patrolAgent?.id === a.id ? null : a">巡检</Button>
          <Button variant="secondary" size="sm" @click="uiStore.openTerminal(a.name)">终端</Button>
          <Button variant="secondary" size="sm" @click="openEdit(a)">编辑</Button>
          <Button variant="ghost" size="sm" class="text-red-500 hover:text-red-600" @click="confirmDelete = a">删除</Button>
        </div>
      </Card>
      <AgentCardSkeleton v-if="loading" />
      <EmptyState
        v-if="!loading && agents.length === 0"
        icon="🤖"
        title="还没有 Agent"
        description="创建一个 AI Agent，让它加入频道协作"
        action-label="+ 创建 Agent"
        @action="openCreate"
      />
    </div>

    <AgentPatrolPanel v-if="patrolAgent" :agent="patrolAgent" @close="patrolAgent = null" />

    <ConfirmDialog
      v-if="confirmDelete"
      :title="`删除 Agent @${confirmDelete.name}`"
      message="将移除该 Agent 及其频道成员关系（历史消息保留）。此操作不可撤销。"
      confirm-label="删除"
      danger
      @confirm="handleConfirmDelete"
      @cancel="confirmDelete = null"
    />
  </div>
</template>
