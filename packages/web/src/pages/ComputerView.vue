<script setup lang="ts">
import { type AgentPresence, composePresence, PRESENCE_LABEL } from "@collabagent/shared";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, apiGet, apiPatch, apiPost } from "../api";
import AgentWorkspacePanel from "../components/agent/AgentWorkspacePanel.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import Avatar from "../components/ui/Avatar.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";
import Modal from "../components/ui/Modal.vue";
import { usePolling } from "../composables";
import { runtimeCatalog, useAgentStore, useAuthStore, useComputerStore, useUiStore } from "../stores";
import { toast } from "../stores/toastStore";

interface AgentRow {
  id: string;
  name: string;
  display_name?: string;
  description?: string;
  isOnline: boolean;
  duty?: "on" | "off";
  presence?: AgentPresence;
  runtime?: string;
  model?: string;
  avatar_url?: string;
  user_id?: string;
}

const route = useRoute();
const computerStore = useComputerStore();
const authStore = useAuthStore();
const agentStore = useAgentStore();
const uiStore = useUiStore();

const error = ref("");
const saving = ref(false);
const nameDraft = ref("");
const descDraft = ref("");
const editing = ref(false);

const tokenCommand = ref("");
const generating = ref(false);
const copied = ref(false);
const confirmRotate = ref(false);
const confirmDelete = ref(false);
const deleting = ref(false);

const agents = ref<AgentRow[]>([]);
const showCreate = ref(false);
const creating = ref(false);
const newName = ref("");
const newDisplayName = ref("");
const newDesc = ref("");
const newAvatarUrl = ref("");
const newRuntime = ref("claude");
const newModel = ref("sonnet");
const createdNote = ref("");
const confirmDeleteAgent = ref<AgentRow | null>(null);
const togglingDuty = ref<string | null>(null);
const confirmOffDuty = ref<AgentRow | null>(null);

const catalog = runtimeCatalog();
const WIRED_RUNTIMES = new Set(["claude"]);
const CLAUDE_MODELS = [
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "opus", label: "Claude Opus" },
  { value: "haiku", label: "Claude Haiku" },
];

const computer = computed(() => computerStore.computer);
const connected = computed(() => computerStore.connected);
const runtimes = computed(() => {
  const live = computerStore.runtimes;
  if (live.length) return live;
  return catalog.map((c) => ({ id: c.id, status: "not_installed" as const, version: undefined }));
});
const snapshot = computed(() => !connected.value && !!computer.value?.lastReadyAt);

const myAgents = computed(() => {
  const uid = authStore.user?.id;
  if (!uid) return agents.value;
  return agents.value.filter((a) => !a.user_id || a.user_id === uid);
});

const claude = computed(() => runtimes.value.find((r) => r.id === "claude"));
const creatableRuntimes = computed(() =>
  runtimes.value.filter((r) => r.status === "installed" && WIRED_RUNTIMES.has(r.id)),
);
const canCreate = computed(() => connected.value && creatableRuntimes.value.length > 0);
const createReady = computed(() => canCreate.value && !!newName.value.trim() && !!newDisplayName.value.trim());
const modelOptions = computed(() => CLAUDE_MODELS);

function labelFor(id: string): string {
  return catalog.find((c) => c.id === id)?.label || id;
}

function chipClass(status: string): string {
  if (status === "installed")
    return "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300";
  if (status === "installed_unsupported")
    return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300";
  return "border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400";
}

function chipHint(status: string): string {
  if (status === "installed") return "已安装";
  if (status === "installed_unsupported") return "已检测到，运行时尚未接入";
  return "未安装";
}

function fmtTime(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function syncDrafts() {
  nameDraft.value = computer.value?.name || "";
  descDraft.value = computer.value?.description || "";
}

async function loadAgents() {
  try {
    const d = await apiGet<{ agents: AgentRow[] }>("/api/agents", { mine: "1" });
    agents.value = d.agents || [];
  } catch {
    try {
      const d = await apiGet<{ agents: AgentRow[] }>("/api/agents");
      const uid = authStore.user?.id;
      agents.value = (d.agents || []).filter((a) => !uid || !a.user_id || a.user_id === uid);
    } catch {
      /* ignore */
    }
  }
}

async function bootstrap() {
  error.value = "";
  try {
    await computerStore.ensure();
    const id = typeof route.params.id === "string" ? route.params.id : "";
    if (id && computerStore.computer && computerStore.computer.id !== id) {
      error.value = "无权查看这台计算机";
      return;
    }
    syncDrafts();
    await loadAgents();
  } catch (err: any) {
    error.value = err?.message || "加载失败";
  }
}

async function saveIdentity() {
  saving.value = true;
  try {
    await apiPatch("/api/computers/me", { name: nameDraft.value.trim(), description: descDraft.value });
    await computerStore.refresh();
    editing.value = false;
    toast.success("已保存");
  } catch (err: any) {
    toast.error(err?.message || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function rotateToken() {
  confirmRotate.value = false;
  generating.value = true;
  error.value = "";
  try {
    const r = await apiPost<{ token: string; command: string }>("/api/computers/me/token", {});
    tokenCommand.value = r.command;
    toast.success("已生成新连接命令（现有连接器会断开）");
    await computerStore.refresh();
  } catch (err: any) {
    error.value = err?.message || "生成失败";
  } finally {
    generating.value = false;
  }
}

async function copyCommand() {
  if (!tokenCommand.value) return;
  try {
    await navigator.clipboard.writeText(tokenCommand.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    toast.error("复制失败，请手动选择命令");
  }
}

function resetCreateForm() {
  newName.value = "";
  newDisplayName.value = "";
  newDesc.value = "";
  newAvatarUrl.value = "";
  newRuntime.value = creatableRuntimes.value[0]?.id || "claude";
  newModel.value = "sonnet";
}

function openCreate() {
  if (!canCreate.value) {
    toast.error("请先连接计算机并安装 Claude Code");
    return;
  }
  resetCreateForm();
  showCreate.value = true;
}

async function createAgent() {
  const n = newName.value.trim();
  const dn = newDisplayName.value.trim();
  if (!n || !dn) return;
  if (!canCreate.value) {
    toast.error("请先连接计算机并安装 Claude Code");
    return;
  }
  creating.value = true;
  try {
    await apiPost("/api/agents", {
      name: n,
      displayName: dn,
      description: newDesc.value.trim(),
      avatarUrl: newAvatarUrl.value.trim(),
      runtime: newRuntime.value,
      model: newModel.value,
    });
    showCreate.value = false;
    resetCreateForm();
    createdNote.value = "已创建。被 @ 时才会拉起进程，不会立刻上线。";
    await loadAgents();
  } catch (err: any) {
    toast.error(err?.message || "创建失败");
  } finally {
    creating.value = false;
  }
}

async function deleteAgent() {
  const a = confirmDeleteAgent.value;
  if (!a) return;
  confirmDeleteAgent.value = null;
  try {
    await apiClient(`/api/agents/${a.id}`, { method: "DELETE" });
    await loadAgents();
  } catch (err: any) {
    toast.error(err?.message || "删除失败");
  }
}

async function deleteComputer() {
  deleting.value = true;
  try {
    await apiClient("/api/computers/me", { method: "DELETE" });
    confirmDelete.value = false;
    toast.success("已删除计算机");
    await computerStore.refresh();
    syncDrafts();
    tokenCommand.value = "";
  } catch (err: any) {
    toast.error(err?.message || "删除失败");
  } finally {
    deleting.value = false;
  }
}

const workspaceAgentId = ref<string | null>(null);

const workspaceAgent = computed(() => myAgents.value.find((a) => a.id === workspaceAgentId.value) || null);

function openAgent(name: string) {
  uiStore.openProfile({ handle: name });
}

function toggleWorkspace(id: string) {
  workspaceAgentId.value = workspaceAgentId.value === id ? null : id;
}

function agentPresence(a: AgentRow): AgentPresence {
  const live = agentStore.agents[a.name];
  if (live?.presence) return live.presence;
  if (a.presence) return a.presence;
  return composePresence(a.duty ?? "on", !!a.isOnline || connected.value, live?.status);
}

function agentLive(a: AgentRow): string {
  return PRESENCE_LABEL[agentPresence(a)]?.text || "空闲";
}

function presenceDot(a: AgentRow): string {
  return PRESENCE_LABEL[agentPresence(a)]?.dot || "bg-gray-400";
}

async function setDuty(a: AgentRow, duty: "on" | "off") {
  togglingDuty.value = a.id;
  try {
    const r = await apiPost<{ duty: "on" | "off"; presence: AgentPresence; isOnline: boolean }>(
      `/api/agents/${a.id}/duty`,
      { duty },
    );
    a.duty = r.duty;
    a.presence = r.presence;
    a.isOnline = r.isOnline;
    agentStore.applyPresence({
      agentName: a.name,
      agentId: a.id,
      duty: r.duty,
      computerOnline: connected.value,
      presence: r.presence,
    });
    toast.success(duty === "off" ? `@${a.name} 已停班` : `@${a.name} 开始值班`);
  } catch (err: any) {
    toast.error(err?.message || "切换值班失败");
  } finally {
    togglingDuty.value = null;
  }
}

function requestDutyOff(a: AgentRow) {
  const live = agentStore.agents[a.name];
  if (live?.status === "working" || live?.status === "starting") {
    confirmOffDuty.value = a;
    return;
  }
  void setDuty(a, "off");
}

function confirmDutyOff() {
  const a = confirmOffDuty.value;
  confirmOffDuty.value = null;
  if (a) void setDuty(a, "off");
}

onMounted(() => {
  void bootstrap();
});
usePolling(() => {
  void computerStore.refresh();
  void loadAgents();
}, 4000);

watch(
  () => computer.value?.id,
  () => syncDrafts(),
);

watch(
  () => route.params.id,
  () => {
    void bootstrap();
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader :title="computer?.name || '我的计算机'" subtitle="在这台电脑上跑连接器，再创建 Agent">
      <span
        :class="[
          'rounded-full px-2 py-0.5 text-xs',
          connected
            ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
            : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
        ]"
      >
        {{ connected ? "在线" : "离线" }}
      </span>
    </PageHeader>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div v-if="error" class="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">
        {{ error }}
      </div>

      <Card class="flex items-start gap-4">
        <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gray-200 text-2xl dark:bg-gray-700">
          💻
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold text-ink">{{ computer?.name || "我的计算机" }}</h2>
            <span :class="['h-2.5 w-2.5 rounded-full', connected ? 'bg-green-500' : 'bg-gray-400']" />
          </div>
          <p class="mt-0.5 text-xs text-muted">{{ computer?.hostname || "尚未上报主机名" }}</p>
          <p v-if="!editing" class="mt-2 text-sm text-gray-600 dark:text-gray-300">
            {{ computer?.description || "还没有描述" }}
          </p>
          <div v-else class="mt-3 space-y-2">
            <Input :value="nameDraft" placeholder="名称" @input="nameDraft = ($event.target as HTMLInputElement).value" />
            <Input :value="descDraft" placeholder="描述" @input="descDraft = ($event.target as HTMLInputElement).value" />
            <div class="flex gap-2">
              <Button size="sm" :loading="saving" @click="saveIdentity">保存</Button>
              <Button size="sm" variant="secondary" @click="editing = false">取消</Button>
            </div>
          </div>
          <button
            v-if="!editing"
            type="button"
            class="mt-2 text-xs text-blue-600 hover:underline dark:text-blue-400"
            @click="editing = true"
          >
            编辑名称 / 描述
          </button>
        </div>
      </Card>

      <Card>
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">信息</p>
        <dl class="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-xs text-muted">系统</dt>
            <dd class="text-gray-800 dark:text-gray-200">{{ computer?.os || "—" }} · {{ computer?.arch || "—" }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted">连接器版本</dt>
            <dd class="text-gray-800 dark:text-gray-200">{{ computer?.daemonVersion || computerStore.status?.daemonVersion || "—" }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted">创建时间</dt>
            <dd class="text-gray-800 dark:text-gray-200">{{ fmtTime(computer?.createdAt) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted">最近就绪</dt>
            <dd class="text-gray-800 dark:text-gray-200">{{ fmtTime(computer?.lastReadyAt || computerStore.status?.connectedAt) }}</dd>
          </div>
        </dl>
        <p v-if="snapshot" class="mt-2 text-xs text-amber-600 dark:text-amber-400">以下探测为上次连接的快照。</p>
      </Card>

      <Card>
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">检测到的运行时</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="r in runtimes"
            :key="r.id"
            :class="['rounded-lg border px-3 py-2 text-sm', chipClass(r.status)]"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="font-medium">{{ labelFor(r.id) }}</span>
              <span class="text-[10px]">{{ chipHint(r.status) }}</span>
            </div>
            <p v-if="r.version" class="mt-0.5 truncate text-[11px] opacity-80">{{ r.version }}</p>
          </div>
        </div>
        <p
          v-if="connected && claude?.status !== 'installed'"
          class="mt-3 text-xs text-amber-700 dark:text-amber-300"
        >
          已连上计算机，但 Claude 未装，@ 不会响应。安装：
          <code class="rounded bg-black/10 px-1 dark:bg-white/10">npm install -g @anthropic-ai/claude-code</code>
        </p>
      </Card>

      <Card class="space-y-3">
        <p class="text-xs font-semibold uppercase tracking-wide text-muted">接入</p>
        <p class="text-sm text-gray-600 dark:text-gray-300">
          在你要跑 Agent 的这台电脑上执行（就是你正在用的这台，不是别人的机器）。
        </p>
        <p class="text-xs text-muted">生成新命令会吊销当前机器令牌，现有连接器会断开。</p>
        <Button size="sm" :loading="generating" @click="confirmRotate = true">生成连接命令</Button>
        <div v-if="tokenCommand" class="space-y-2">
          <div class="break-all rounded bg-gray-900 p-3 font-mono text-xs text-green-400 dark:bg-black">{{ tokenCommand }}</div>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="secondary" @click="copyCommand">{{ copied ? "已复制 ✓" : "复制命令" }}</Button>
          </div>
          <p class="text-xs text-muted">令牌只显示这一次。密钥不会回放。</p>
          <div v-if="!connected" class="flex items-center gap-2 text-sm text-gray-500">
            <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            等待连接器就绪…
          </div>
        </div>
      </Card>

      <Card class="space-y-3">
        <div class="flex items-center justify-between">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">
            这台计算机上的 Agent · {{ myAgents.length }}
          </p>
          <Button size="sm" :disabled="!canCreate" @click="openCreate">创建</Button>
        </div>
        <p v-if="!canCreate" class="text-xs text-muted">
          {{ connected ? "安装 Claude Code 后才能创建。" : "先连接这台计算机，再创建 Agent。" }}
        </p>
        <p v-if="createdNote" class="text-xs text-blue-600 dark:text-blue-400">{{ createdNote }}</p>
        <p v-if="myAgents.length === 0" class="text-sm text-muted">还没有 Agent</p>
        <div
          v-for="a in myAgents"
          :key="a.id"
          class="group flex w-full items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 text-left hover:opacity-90"
            @click="openAgent(a.name)"
          >
            <span :class="['h-2 w-2 shrink-0 rounded-full', presenceDot(a)]" />
            <Avatar :name="a.display_name || a.name" :src="a.avatar_url" size="sm" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-ink">{{ a.display_name || a.name }}</p>
              <p class="truncate text-xs text-muted">{{ a.runtime || "claude" }} · {{ agentLive(a) }}</p>
            </div>
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            :class="workspaceAgentId === a.id ? 'border-blue-300 text-blue-600 dark:border-blue-700 dark:text-blue-300' : ''"
            title="查看 MEMORY.md / notes"
            @click="toggleWorkspace(a.id)"
          >
            工作区
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            :disabled="!connected || togglingDuty === a.id"
            :title="connected ? (a.duty === 'off' ? '开始值班' : '停班后仍是成员，只是不接活') : '先连上这台计算机'"
            @click="a.duty === 'off' ? setDuty(a, 'on') : requestDutyOff(a)"
          >
            {{ a.duty === "off" ? "已停班" : "值班中" }}
          </button>
          <Button
            variant="ghost"
            size="sm"
            class="shrink-0 text-red-500 opacity-0 hover:text-red-600 group-hover:opacity-100"
            @click="confirmDeleteAgent = a"
          >
            删除
          </Button>
        </div>
        <AgentWorkspacePanel
          v-if="workspaceAgent"
          :agent-id="workspaceAgent.id"
          :agent-name="workspaceAgent.name"
          :computer-online="connected"
        />
      </Card>

      <Card class="space-y-2 border-red-200 dark:border-red-900/50">
        <p class="text-xs font-semibold uppercase tracking-wide text-red-500">危险区</p>
        <p class="text-sm text-gray-600 dark:text-gray-300">删除计算机前必须先清空这台上的 Agent。</p>
        <Button variant="danger" size="sm" :disabled="myAgents.length > 0" @click="confirmDelete = true">
          删除计算机
        </Button>
      </Card>
    </div>

    <Modal :open="showCreate" width-class="max-w-md" @close="showCreate = false">
      <h3 class="text-base font-bold text-ink">创建 Agent</h3>
      <p class="mt-1 text-xs text-gray-500">会挂在你这台计算机上。被 @ 时才会拉起。</p>
      <div class="mt-3 space-y-2">
        <Input
          type="text"
          placeholder="名称 (如 slock-backend)"
          :value="newName"
          @input="newName = ($event.target as HTMLInputElement).value"
        />
        <Input
          type="text"
          placeholder="显示名称"
          :value="newDisplayName"
          @input="newDisplayName = ($event.target as HTMLInputElement).value"
        />
        <Input
          type="text"
          placeholder="描述 / 角色设定（可选）"
          :value="newDesc"
          @input="newDesc = ($event.target as HTMLInputElement).value"
        />
        <Input
          type="text"
          placeholder="头像 URL（可选）"
          :value="newAvatarUrl"
          @input="newAvatarUrl = ($event.target as HTMLInputElement).value"
        />
        <div class="flex gap-2">
          <select
            v-model="newRuntime"
            class="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            <option v-for="r in creatableRuntimes" :key="r.id" :value="r.id">{{ labelFor(r.id) }}</option>
          </select>
          <select
            v-model="newModel"
            class="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            <option v-for="m in modelOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
        </div>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" @click="showCreate = false">取消</Button>
        <Button size="sm" :disabled="!createReady" :loading="creating" @click="createAgent">创建</Button>
      </div>
    </Modal>

    <ConfirmDialog
      v-if="confirmRotate"
      title="生成新的连接命令？"
      message="会吊销当前机器令牌，正在运行的连接器会断开，需要用新命令重新启动。"
      confirm-label="生成"
      danger
      @confirm="rotateToken"
      @cancel="confirmRotate = false"
    />
    <ConfirmDialog
      v-if="confirmOffDuty"
      :title="`让 @${confirmOffDuty.name} 停班？`"
      message="当前回合会中止，未完成输出不会代发。停班后仍是成员，只是不接活。"
      confirm-label="停班"
      danger
      @confirm="confirmDutyOff"
      @cancel="confirmOffDuty = null"
    />
    <ConfirmDialog
      v-if="confirmDeleteAgent"
      :title="`删除 Agent @${confirmDeleteAgent.name}`"
      message="将移除该 Agent 及其频道成员关系（历史消息保留）。此操作不可撤销。"
      confirm-label="删除"
      danger
      @confirm="deleteAgent"
      @cancel="confirmDeleteAgent = null"
    />
    <ConfirmDialog
      v-if="confirmDelete"
      title="删除这台计算机？"
      message="此操作不可撤销。请确认这台上已经没有 Agent。"
      confirm-label="删除"
      danger
      @confirm="deleteComputer"
      @cancel="confirmDelete = false"
    />
  </div>
</template>
