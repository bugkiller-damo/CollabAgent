<script setup lang="ts">
import { type AgentPresence, composePresence, PRESENCE_LABEL } from "@collabagent/shared";
import { Check, Monitor } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient, apiGet, apiPatch, apiPost } from "../api";
import AgentWorkspacePanel from "../components/agent/AgentWorkspacePanel.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import Avatar from "../components/ui/Avatar.vue";
import AvatarPresetPicker from "../components/ui/AvatarPresetPicker.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";
import Modal from "../components/ui/Modal.vue";
import { usePolling } from "../composables";
import {
  type ComputerRecord,
  claudeInstalled,
  runtimeCatalog,
  useAgentStore,
  useAuthStore,
  useComputerStore,
  useServerStore,
  useUiStore,
} from "../stores";
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
  /** server 端解析出的宿主机（绑定机优先，存量 agent 回落属主同 server 任一机） */
  computer?: { id: string; name: string; hostname: string | null; online: boolean } | null;
}

const route = useRoute();
const router = useRouter();
const computerStore = useComputerStore();
const authStore = useAuthStore();
const agentStore = useAgentStore();
const serverStore = useServerStore();
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

/** 详情页直取（member 可读任意 server 的行）——列表只覆盖活跃 server，深链可能跨界 */
const detailRow = ref<ComputerRecord | null>(null);
const detailMissing = ref(false);

const catalog = runtimeCatalog();
const WIRED_RUNTIMES = new Set(["claude"]);
const CLAUDE_MODELS = [
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "opus", label: "Claude Opus" },
  { value: "haiku", label: "Claude Haiku" },
];

const routeId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const detailMode = computed(() => !!routeId.value);

const computers = computed(() => computerStore.computers);
const myComputers = computed(() => computerStore.myComputers);
const otherComputers = computed(() => computers.value.filter((c) => !c.mine));

const computer = computed<ComputerRecord | null>(() => {
  if (!detailMode.value) return null;
  return detailRow.value ?? computers.value.find((c) => c.id === routeId.value) ?? null;
});
const isMine = computed(() => !!computer.value?.mine);
const online = computed(() => !!computer.value?.online);
const runtimes = computed(() => {
  const live = computer.value?.runtimes;
  if (live && live.length) return live;
  return catalog.map((c) => ({ id: c.id, status: "not_installed" as const, version: undefined }));
});
const snapshot = computed(() => !online.value && !!computer.value?.lastReadyAt);

/** server 归属查询（orgs 未覆盖时回落 serverId 本身——例如我不是该 server 成员的边缘态） */
function serverNameOf(serverId: string): string {
  return serverStore.orgs.find((o) => o.id === serverId)?.name || "该 server";
}
/** 令牌签发是 owner-only：活跃 server 我是 owner 才可生成接入命令 */
const canAttachActive = computed(() => serverStore.activeServer?.role === "owner");
/** 详情页该机所在 server 我是否 owner（理论上我的机器必在我 own 的 server，转让后是边缘态） */
const canAttachDetail = computed(
  () => isMine.value && serverStore.orgs.find((o) => o.id === computer.value?.serverId)?.role === "owner",
);

const boundAgents = computed(() => {
  const id = computer.value?.id;
  if (!id) return [];
  return agents.value.filter((a) => a.computer?.id === id);
});
const claude = computed(() => runtimes.value.find((r) => r.id === "claude"));
const creatableRuntimes = computed(() =>
  runtimes.value.filter((r) => r.status === "installed" && WIRED_RUNTIMES.has(r.id)),
);
const canCreate = computed(
  () => isMine.value && online.value && canAttachDetail.value && creatableRuntimes.value.length > 0,
);
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
  const d = new Date(v);
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

async function loadDetail() {
  detailRow.value = null;
  detailMissing.value = false;
  if (!routeId.value) return;
  try {
    const d = await apiGet<{ computer: ComputerRecord }>(`/api/computers/${routeId.value}`);
    detailRow.value = d.computer;
  } catch {
    detailMissing.value = true;
  }
}

async function bootstrap() {
  error.value = "";
  try {
    if (!serverStore.loaded) await serverStore.fetchOrgs();
    await computerStore.refresh();
    if (detailMode.value) {
      await loadDetail();
      if (!computer.value) {
        error.value = detailMissing.value ? "计算机不存在或无权查看" : "";
        if (!error.value) error.value = "计算机不在当前 server，或无访问权";
      } else {
        syncDrafts();
      }
    }
    await loadAgents();
  } catch (err: any) {
    error.value = err?.message || "加载失败";
  }
}

async function saveIdentity() {
  const c = computer.value;
  if (!c) return;
  saving.value = true;
  try {
    await apiPatch(`/api/computers/${c.id}`, { name: nameDraft.value.trim(), description: descDraft.value });
    await Promise.all([computerStore.refresh(), loadDetail()]);
    editing.value = false;
    toast.success("已保存");
  } catch (err: any) {
    toast.error(err?.message || "保存失败");
  } finally {
    saving.value = false;
  }
}

/** 生成接入命令——scope 由调用点决定：列表页=活跃 server；详情页=该机所在 server */
const rotateScope = ref<string | null>(null);
async function rotateToken() {
  const serverId = rotateScope.value;
  confirmRotate.value = false;
  if (!serverId) return;
  generating.value = true;
  error.value = "";
  try {
    const r = await apiPost<{ token: string; command: string }>("/api/computers/me/token", { serverId });
    tokenCommand.value = r.command;
    toast.success("已生成新连接命令");
  } catch (err: any) {
    error.value = err?.message || "生成失败";
  } finally {
    generating.value = false;
  }
}

function requestRotate(serverId: string) {
  rotateScope.value = serverId;
  confirmRotate.value = true;
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
    toast.error("需要该机在线、装了 Claude Code，且你是其 server 所有者");
    return;
  }
  resetCreateForm();
  showCreate.value = true;
}

async function createAgent() {
  const c = computer.value;
  const n = newName.value.trim();
  const dn = newDisplayName.value.trim();
  if (!n || !dn || !c) return;
  if (!canCreate.value) {
    toast.error("需要该机在线、装了 Claude Code，且你是其 server 所有者");
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
      // server-scoped computers：显式绑定该机——serverId 与 computerId 同出自行数据，
      // 服务端复核 (user, server, computer) 一致性后落 agents.computer_id
      serverId: c.serverId,
      computerId: c.id,
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
  const c = computer.value;
  if (!c) return;
  deleting.value = true;
  try {
    await apiClient(`/api/computers/${c.id}`, { method: "DELETE" });
    confirmDelete.value = false;
    toast.success("已删除计算机");
    tokenCommand.value = "";
    await computerStore.refresh();
    void router.push("/computers");
  } catch (err: any) {
    confirmDelete.value = false;
    toast.error(err?.message || "删除失败");
  } finally {
    deleting.value = false;
  }
}

const workspaceAgentId = ref<string | null>(null);

const workspaceAgent = computed(() => boundAgents.value.find((a) => a.id === workspaceAgentId.value) || null);

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
  return composePresence(a.duty ?? "on", !!(a.computer?.online ?? a.isOnline), live?.status);
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
      computerOnline: !!a.computer?.online,
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

function goComputer(id: string) {
  void router.push("/computers/" + id);
}

function goComputersBack() {
  void router.push("/computers");
}

onMounted(() => {
  void bootstrap();
});
usePolling(() => {
  void computerStore.refresh().then(() => {
    if (detailMode.value) void loadDetail();
  });
  void loadAgents();
}, 4000);

watch(
  () => computer.value?.id,
  () => syncDrafts(),
);

watch(
  () => route.params.id,
  () => {
    editing.value = false;
    workspaceAgentId.value = null;
    void bootstrap();
  },
);

// 列表是活跃 server 语境——切 server 即换一批机器
watch(
  () => serverStore.activeServerId,
  () => {
    if (!detailMode.value) void computerStore.refresh();
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader
      :title="detailMode ? computer?.name || '计算机' : `计算机 · ${serverStore.activeServer?.name || ''}`"
      :subtitle="
        detailMode
          ? isMine
            ? '这台机器上跑连接器，再创建 Agent'
            : `属主：${computer?.ownerName || computer?.ownerHandle || '成员'}`
          : '本 server 里注册的机器——daemon 跑起来才会出现'
      "
    >
      <span
        v-if="detailMode && computer"
        :class="[
          'rounded-full px-2 py-0.5 text-xs',
          online
            ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
            : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
        ]"
      >
        {{ online ? "在线" : "离线" }}
      </span>
    </PageHeader>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div v-if="error" class="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">
        {{ error }}
      </div>

      <!-- ======================= 列表模式 ======================= -->
      <template v-if="!detailMode">
        <Card class="space-y-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">接入</p>
          <p class="text-sm text-gray-600 dark:text-gray-300">
            在要接入「{{ serverStore.activeServer?.name || "本 server" }}」的电脑上执行连接命令——一台机器一条 daemon
            进程，同时只服务一个 server。
          </p>
          <template v-if="canAttachActive">
            <Button size="sm" :loading="generating" @click="requestRotate(serverStore.activeServer!.id)">
              生成连接命令
            </Button>
            <div v-if="tokenCommand" class="space-y-2">
              <div class="break-all rounded bg-gray-900 p-3 font-mono text-xs text-green-400 dark:bg-black">
                {{ tokenCommand }}
              </div>
              <div class="flex items-center gap-2">
                <Button size="sm" variant="secondary" @click="copyCommand">
                  <Check v-if="copied" class="mr-0.5 inline h-3.5 w-3.5" aria-hidden="true" />
                  {{ copied ? "已复制" : "复制命令" }}
                </Button>
              </div>
              <p class="text-xs text-muted">令牌只显示这一次。命令里的 --server 会与本 server 校验，写错会拒连。</p>
            </div>
          </template>
          <p v-else class="text-xs text-muted">只有本 server 的所有者可以接入计算机。</p>
        </Card>

        <Card>
          <p class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            我的计算机 · {{ myComputers.length }}
          </p>
          <p v-if="myComputers.length === 0" class="text-sm text-muted">
            {{ canAttachActive ? "还没有你的机器接入本 server——用上面的命令跑起来。" : "你还没有机器接入本 server。" }}
          </p>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="c in myComputers"
              :key="c.id"
              type="button"
              class="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left hover:border-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-700"
              @click="goComputer(c.id)"
            >
              <Monitor class="h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-ink">{{ c.name }}</p>
                <p class="truncate text-xs text-muted">{{ c.hostname || "—" }}</p>
              </div>
              <span :class="['h-2 w-2 shrink-0 rounded-full', c.online ? 'bg-green-500' : 'bg-gray-400']" />
            </button>
          </div>
        </Card>

        <Card v-if="otherComputers.length > 0">
          <p class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            成员的计算机 · {{ otherComputers.length }}
          </p>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="c in otherComputers"
              :key="c.id"
              type="button"
              class="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left hover:border-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-700"
              @click="goComputer(c.id)"
            >
              <Monitor class="h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-ink">{{ c.name }}</p>
                <p class="truncate text-xs text-muted">
                  {{ c.ownerName || c.ownerHandle || "成员" }} · {{ c.hostname || "—" }}
                </p>
              </div>
              <span :class="['h-2 w-2 shrink-0 rounded-full', c.online ? 'bg-green-500' : 'bg-gray-400']" />
            </button>
          </div>
        </Card>
      </template>

      <!-- ======================= 详情模式 ======================= -->
      <template v-else-if="computer">
        <button type="button" class="text-xs text-blue-600 hover:underline dark:text-blue-400" @click="goComputersBack">
          ← 全部计算机
        </button>

        <Card class="flex items-start gap-4">
          <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gray-200 dark:bg-gray-700">
            <Monitor class="h-7 w-7" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-lg font-semibold text-ink">{{ computer.name }}</h2>
              <span :class="['h-2.5 w-2.5 rounded-full', online ? 'bg-green-500' : 'bg-gray-400']" />
              <span v-if="!isMine" class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-muted dark:bg-gray-700">
                {{ computer.ownerName || computer.ownerHandle || "成员" }} 的机器
              </span>
            </div>
            <p class="mt-0.5 text-xs text-muted">{{ computer.hostname || "尚未上报主机名" }}</p>
            <p v-if="!editing" class="mt-2 text-sm text-gray-600 dark:text-gray-300">
              {{ computer.description || "还没有描述" }}
            </p>
            <div v-else class="mt-3 space-y-2">
              <Input
                :value="nameDraft"
                placeholder="名称"
                @input="nameDraft = ($event.target as HTMLInputElement).value"
              />
              <Input
                :value="descDraft"
                placeholder="描述"
                @input="descDraft = ($event.target as HTMLInputElement).value"
              />
              <div class="flex gap-2">
                <Button size="sm" :loading="saving" @click="saveIdentity">保存</Button>
                <Button size="sm" variant="secondary" @click="editing = false">取消</Button>
              </div>
            </div>
            <button
              v-if="!editing && isMine"
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
              <dd class="text-gray-800 dark:text-gray-200">{{ computer.os || "—" }} · {{ computer.arch || "—" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted">连接器版本</dt>
              <dd class="text-gray-800 dark:text-gray-200">{{ computer.daemonVersion || "—" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted">所在 server</dt>
              <dd class="text-gray-800 dark:text-gray-200">{{ serverNameOf(computer.serverId) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted">最近就绪</dt>
              <dd class="text-gray-800 dark:text-gray-200">{{ fmtTime(computer.lastReadyAt || computer.connectedAt) }}</dd>
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
          <p v-if="online && claude?.status !== 'installed'" class="mt-3 text-xs text-amber-700 dark:text-amber-300">
            已连上计算机，但 Claude 未装，@ 不会响应。安装：
            <code class="rounded bg-black/10 px-1 dark:bg-white/10">npm install -g @anthropic-ai/claude-code</code>
          </p>
        </Card>

        <Card v-if="isMine && canAttachDetail" class="space-y-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">接入</p>
          <p class="text-sm text-gray-600 dark:text-gray-300">
            为「{{ serverNameOf(computer.serverId) }}」生成新的连接命令——可在本机或其他电脑上执行，每台机器一条
            daemon 进程。
          </p>
          <Button size="sm" :loading="generating" @click="requestRotate(computer.serverId)">生成连接命令</Button>
          <div v-if="tokenCommand" class="space-y-2">
            <div class="break-all rounded bg-gray-900 p-3 font-mono text-xs text-green-400 dark:bg-black">
              {{ tokenCommand }}
            </div>
            <div class="flex items-center gap-2">
              <Button size="sm" variant="secondary" @click="copyCommand">
                <Check v-if="copied" class="mr-0.5 inline h-3.5 w-3.5" aria-hidden="true" />
                {{ copied ? "已复制" : "复制命令" }}
              </Button>
            </div>
            <p class="text-xs text-muted">令牌只显示这一次。换 server 接入请回到对应 server 再生成。</p>
          </div>
        </Card>

        <Card class="space-y-3">
          <div class="flex items-center justify-between">
            <p class="text-xs font-semibold uppercase tracking-wide text-muted">
              这台计算机上的 Agent · {{ boundAgents.length }}
            </p>
            <Button v-if="isMine" size="sm" :disabled="!canCreate" @click="openCreate">创建</Button>
          </div>
          <p v-if="isMine && !canCreate" class="text-xs text-muted">
            {{
              !online
                ? "先让这台机器的 daemon 上线，再创建 Agent。"
                : !canAttachDetail
                  ? "只有 server 所有者能在本 server 放置 Agent。"
                  : "安装 Claude Code 后才能创建。"
            }}
          </p>
          <p v-if="createdNote" class="text-xs text-blue-600 dark:text-blue-400">{{ createdNote }}</p>
          <p v-if="boundAgents.length === 0" class="text-sm text-muted">还没有 Agent 绑定这台机器</p>
          <div
            v-for="a in boundAgents"
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
            <template v-if="isMine">
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
                :disabled="!online || togglingDuty === a.id"
                :title="online ? (a.duty === 'off' ? '开始值班' : '停班后仍是成员，只是不接活') : '先让这台机器上线'"
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
            </template>
          </div>
          <AgentWorkspacePanel
            v-if="workspaceAgent"
            :agent-id="workspaceAgent.id"
            :agent-name="workspaceAgent.name"
            :computer-online="online"
          />
        </Card>

        <Card v-if="isMine" class="space-y-2 border-red-200 dark:border-red-900/50">
          <p class="text-xs font-semibold uppercase tracking-wide text-red-500">危险区</p>
          <p class="text-sm text-gray-600 dark:text-gray-300">
            删除计算机前必须先清空绑定其上的 Agent（{{ boundAgents.length }} 个）。
          </p>
          <Button variant="danger" size="sm" :disabled="boundAgents.length > 0" @click="confirmDelete = true">
            删除计算机
          </Button>
        </Card>
      </template>

      <p v-else-if="!error" class="text-sm text-muted">加载中…</p>
    </div>

    <Modal :open="showCreate" width-class="max-w-md" @close="showCreate = false">
      <h3 class="text-base font-bold text-ink">创建 Agent</h3>
      <p class="mt-1 text-xs text-gray-500">
        将创建于「{{ serverNameOf(computer?.serverId || "") }}」，绑定在 {{ computer?.name }} 上。被 @ 时才会拉起。
      </p>
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
        <div class="flex items-center gap-2">
          <AvatarPresetPicker
            :current="newAvatarUrl"
            :letter-name="newDisplayName || newName || '?'"
            @select="newAvatarUrl = $event"
          />
          <Input
            type="text"
            placeholder="头像 URL（可选），或点左侧头像挑选"
            :value="newAvatarUrl"
            @input="newAvatarUrl = ($event.target as HTMLInputElement).value"
            class="min-w-0 flex-1"
          />
        </div>
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
      message="会为该 server 签发一枚机器令牌（同 server 可有多枚，分别给不同机器用）。"
      confirm-label="生成"
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
