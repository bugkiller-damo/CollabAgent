<script setup lang="ts">
import { type AgentPresence, composePresence, PRESENCE_LABEL } from "@collabagent/shared";
import { Check, Crown, UserPlus, X } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, apiGet, apiPost } from "../api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import SidebarSection from "../components/layout/SidebarSection.vue";
import MemberProfileBody from "../components/people/MemberProfileBody.vue";
import Avatar from "../components/ui/Avatar.vue";
import Input from "../components/ui/Input.vue";
import { LG_QUERY, useMediaQuery } from "../composables";
import { runtimeCatalog, useAgentStore, useAuthStore, useChannelStore, useServerStore, useUiStore } from "../stores";
import { toast } from "../stores/toastStore";

interface AgentComputer {
  id: string;
  name: string;
  hostname?: string | null;
  online?: boolean;
}

interface Agent {
  id: string;
  name: string;
  display_name: string;
  isOnline: boolean;
  duty?: "on" | "off";
  presence?: AgentPresence;
  avatar_url?: string;
  description?: string;
  runtime?: string;
  model?: string;
  user_id?: string;
  server_id?: string;
  computer?: AgentComputer | null;
}

interface Member {
  user_id: string;
  role: string;
  handle: string;
  display_name?: string;
  avatar_url?: string;
}
interface Invite {
  token: string;
  role: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
}

const route = useRoute();
const uiStore = useUiStore();
const agentStore = useAgentStore();
const channelStore = useChannelStore();
const authStore = useAuthStore();
const serverStore = useServerStore();
const isDesktop = useMediaQuery(LG_QUERY);

const agents = ref<Agent[]>([]);
const members = ref<Member[]>([]);
const loaded = ref(false);
const query = ref("");

// ---- server 成员管理（融合自原设置页 WorkspaceMembers）----
// 数据源 /api/orgs/:id/members（成员可读，返回 role+user_id+avatar_url）；
// 移除/转让/邀请链接管理是 owner-only（后端 isOrgOwner 门禁，前端仅 owner 展示）。
const isServerOwner = computed(() => serverStore.activeServer?.role === "owner");
const invites = ref<Invite[]>([]);
const invitePanelOpen = ref(false);
const addHandle = ref("");
const addBusy = ref(false);
const inviteBusy = ref(false);
const copiedToken = ref("");
const removeTarget = ref<Member | null>(null);
const transferTarget = ref<Member | null>(null);
const actionBusy = ref(false);

const activeInvites = computed(() => invites.value.filter((i) => !i.revoked_at));

function roleLabel(r: string) {
  return r === "owner" ? "所有者" : "成员";
}

function loadInvites(sid: string) {
  if (!isServerOwner.value) {
    invites.value = [];
    return;
  }
  apiGet<{ invites: Invite[] }>(`/api/orgs/${sid}/invites`)
    .then((d) => {
      invites.value = d.invites || [];
    })
    .catch(() => {
      invites.value = [];
    });
}

async function addMember() {
  const sid = serverStore.activeServerId;
  const handle = addHandle.value.trim().replace(/^@/, "");
  if (!sid || !handle || addBusy.value) return;
  addBusy.value = true;
  try {
    await apiPost(`/api/orgs/${sid}/members`, { handle });
    addHandle.value = "";
    toast.success(`已添加 @${handle}`);
    void loadMembers(sid);
  } catch (e: any) {
    toast.error(e?.message || "添加失败");
  } finally {
    addBusy.value = false;
  }
}

async function createInvite() {
  const sid = serverStore.activeServerId;
  if (!sid || inviteBusy.value) return;
  inviteBusy.value = true;
  try {
    await apiPost(`/api/orgs/${sid}/invites`, { expiresInDays: 7 });
    loadInvites(sid);
  } catch (e: any) {
    toast.error(e?.message || "生成失败");
  } finally {
    inviteBusy.value = false;
  }
}

function inviteUrl(token: string) {
  return `${window.location.origin}/register?invite=${token}`;
}

async function copyInvite(token: string) {
  try {
    await navigator.clipboard.writeText(inviteUrl(token));
    copiedToken.value = token;
    setTimeout(() => {
      copiedToken.value = "";
    }, 2000);
  } catch {
    toast.error("复制失败");
  }
}

async function revokeInvite(token: string) {
  const sid = serverStore.activeServerId;
  if (!sid) return;
  try {
    await apiClient(`/api/orgs/${sid}/invites/${token}`, { method: "DELETE" });
    loadInvites(sid);
  } catch (e: any) {
    toast.error(e?.message || "吊销失败");
  }
}

async function confirmRemove() {
  const m = removeTarget.value;
  const sid = serverStore.activeServerId;
  removeTarget.value = null;
  if (!m || !sid) return;
  actionBusy.value = true;
  try {
    await apiClient(`/api/orgs/${sid}/members/${m.user_id}`, { method: "DELETE" });
    toast.success(`已移除 @${m.handle}`);
    void loadMembers(sid);
  } catch (e: any) {
    toast.error(e?.message || "移除失败");
  } finally {
    actionBusy.value = false;
  }
}

// 转让后我降为 member——isServerOwner 翻 false，行内操作与邀请面板自动收起；
// serverStore 同步刷新让 activeServer.role 落到新口径
async function confirmTransfer() {
  const m = transferTarget.value;
  const sid = serverStore.activeServerId;
  transferTarget.value = null;
  if (!m || !sid) return;
  actionBusy.value = true;
  try {
    await apiClient(`/api/orgs/${sid}/transfer`, { method: "POST", body: { userId: m.user_id } });
    toast.success(`已将所有权转让给 @${m.handle}`);
    void loadMembers(sid);
    void serverStore.fetchOrgs();
  } catch (e: any) {
    toast.error(e?.message || "转让失败");
  } finally {
    actionBusy.value = false;
  }
}

function openFromQuery() {
  const m = typeof route.query.member === "string" ? route.query.member.trim() : "";
  if (m) uiStore.openProfile({ handle: m.replace(/^@/, "") });
}

// P1-11：两个列表独立加载、失败原因分别记录——失败不再伪装成「还没有成员」
const agentsError = ref("");
const membersError = ref("");

function loadMembers(sid: string) {
  membersError.value = "";
  return apiGet<{ members: Member[] }>(`/api/orgs/${sid}/members`)
    .then((d) => {
      members.value = d.members || [];
    })
    .catch((err: any) => {
      membersError.value = err?.message || "网络错误";
    });
}

async function load() {
  agentsError.value = "";
  membersError.value = "";
  const sid = serverStore.activeServerId;
  const agentsReq = apiGet<{ agents: Agent[] }>("/api/agents")
    .then((a) => {
      // agent 是 server 级记录：成员页只列活跃 server 的 agent（跨 server 同名不混）
      const all = a.agents || [];
      agents.value = sid ? all.filter((x) => String(x.server_id) === sid) : all;
    })
    .catch((err: any) => {
      agentsError.value = err?.message || "网络错误";
    });
  const membersReq = sid ? loadMembers(sid) : Promise.resolve();
  loadInvites(sid || "");
  await Promise.all([agentsReq, membersReq]);
}

onMounted(async () => {
  await load();
  loaded.value = true;
  openFromQuery();
});

// 切 server 后成员语境整体更换，重拉
watch(
  () => serverStore.activeServerId,
  () => {
    if (loaded.value) void load();
  },
);

// 任一成员资料变更（profile:update / 本页保存 → membersVersion 递增）重拉——
// 本页 agents/members 是自持副本，不刷新会滞留旧头像/显示名
watch(
  () => channelStore.membersVersion,
  () => {
    if (loaded.value) void load();
  },
);

function retryLoad() {
  void load();
}

watch(
  () => route.query.member,
  () => openFromQuery(),
);

const liveAgents = computed(() => agentStore.agents);

function statusFor(a: Agent): { text: string; cls: string; dot: string } {
  const live = liveAgents.value[a.name];
  const presence = live?.presence || a.presence || composePresence(a.duty ?? "on", !!a.isOnline, live?.status);
  return PRESENCE_LABEL[presence] || PRESENCE_LABEL.computer_offline;
}

function runtimeLine(a: Agent): string {
  const rid = a.runtime || "claude";
  const label = runtimeCatalog().find((c) => c.id === rid)?.label || rid;
  return `${label} · ${a.model || "sonnet"}`;
}

function matchesQuery(display: string, handle: string): boolean {
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  return display.toLowerCase().includes(q) || handle.toLowerCase().includes(q);
}

const filteredAgents = computed(() => agents.value.filter((a) => matchesQuery(a.display_name || a.name, a.name)));
const filteredMembers = computed(() => members.value.filter((m) => matchesQuery(m.display_name || m.handle, m.handle)));

interface AgentComputerGroup {
  key: string;
  title: string;
  subtitle: string;
  online: boolean;
  agents: Agent[];
}

const agentComputerGroups = computed<AgentComputerGroup[]>(() => {
  const map = new Map<string, AgentComputerGroup>();
  for (const a of filteredAgents.value) {
    const c = a.computer;
    const key = c?.id || `unhosted:${a.user_id || a.id}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        title: c?.name || "未登记计算机",
        subtitle: c?.hostname || (c ? "主机未上报" : "创建后会挂到主人的计算机"),
        online: !!c?.online,
        agents: [],
      };
      map.set(key, g);
    }
    g.agents.push(a);
  }
  return [...map.values()].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.title.localeCompare(b.title, "zh");
  });
});

// P1-11：有失败记录时「全空」不算真空——错误态优先于「还没有成员」
const anyError = computed(() => agentsError.value || membersError.value);
const loadFailed = computed(
  () => loaded.value && !!anyError.value && agents.value.length === 0 && members.value.length === 0,
);
const empty = computed(
  () => loaded.value && agents.value.length === 0 && members.value.length === 0 && !anyError.value,
);
const filterEmpty = computed(
  () => loaded.value && !empty.value && filteredAgents.value.length === 0 && filteredMembers.value.length === 0,
);

const selectedHandle = computed(() => uiStore.profileTarget?.handle || "");

function openPerson(handle: string) {
  uiStore.openProfile({ handle });
}

function onAgentDeleted(handle: string) {
  agents.value = agents.value.filter((a) => a.name !== handle && a.id !== handle);
}

// ---- owner 移出他人 agent（DELETE /api/orgs/:id/agents/:agentId）----
// 踢出而非销毁：后端把 agents.server_id 重指到属主最早拥有的 server（优先带
// 计算机的），agent 本体不动；属主无其他 owned server 时后端 409。
// 行能区分「他人 agent」靠 user_id（缺该字段的存量行不显示入口，宁缺勿滥）。
const kickingId = ref<string | null>(null);

function canKick(a: Agent): boolean {
  return isServerOwner.value && !!a.user_id && a.user_id !== authStore.user?.id;
}

async function kickAgent(a: Agent) {
  const sid = serverStore.activeServerId;
  if (!sid || !canKick(a)) return;
  kickingId.value = a.id;
  try {
    await apiClient(`/api/orgs/${sid}/agents/${a.id}`, { method: "DELETE" });
    agents.value = agents.value.filter((x) => x.id !== a.id);
    toast.success(`@${a.name} 已移出服务器`);
  } catch (err: any) {
    toast.error(err?.message || "移出失败");
  } finally {
    kickingId.value = null;
  }
}

const footerLabel = computed(() => `${members.value.length} 位成员 · ${agents.value.length} 个 Agent`);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader title="成员" subtitle="工作区里的人与 Agent" />

    <div class="flex min-h-0 flex-1">
      <div
        class="flex min-h-0 w-full flex-col border-line lg:w-80 lg:shrink-0 lg:border-r"
      >
        <div class="border-b border-gray-200 p-2 dark:border-gray-700">
          <Input
            type="search"
            placeholder="搜索显示名或 @handle"
            :value="query"
            @input="query = ($event.target as HTMLInputElement).value"
          />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <p v-if="!loaded" class="py-8 text-center text-sm text-muted">加载中…</p>
          <!-- P1-11：加载失败显示错误态 + 重试，不再伪装成「还没有成员」 -->
          <EmptyState
            v-else-if="loadFailed"
            icon="alert"
            title="成员加载失败"
            :description="anyError"
            action-label="重试"
            @action="retryLoad"
          />
          <EmptyState
            v-else-if="empty"
            icon="users"
            title="还没有成员"
            description="连接计算机创建 Agent，或邀请同事后，会显示在这里"
          />
          <p v-else-if="filterEmpty" class="px-2 py-6 text-center text-sm text-muted">没有匹配的成员</p>

          <template v-else>
            <!-- P1-11：部分列表失败（另一列表有数据）时顶部警告，不静默缺一块 -->
            <p
              v-if="anyError"
              class="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
            >
              {{ agentsError ? "Agent 列表" : "" }}{{ agentsError && membersError ? "、" : "" }}{{ membersError ? "成员列表" : "" }}
              加载失败（{{ anyError }}），当前显示可能不完整
            </p>
            <div class="mb-3">
              <div class="mb-1 flex items-center justify-between px-2">
                <span class="text-xs font-semibold uppercase tracking-wider text-muted">Agent</span>
                <span class="text-[10px] tabular-nums text-muted">{{ filteredAgents.length }}</span>
              </div>
              <p v-if="filteredAgents.length === 0" class="mb-1 px-2 text-xs text-muted">没有匹配的 Agent</p>
              <SidebarSection
                v-for="g in agentComputerGroups"
                :key="g.key"
                :title="g.title"
                :persist-key="'people.page.computer.' + g.key"
                :count="g.agents.length"
                class-name="mb-2"
              >
                <p class="mb-1 px-2 text-[10px] text-muted">
                  <span :class="g.online ? 'text-green-500' : 'text-muted'">{{ g.online ? "在线" : "离线" }}</span>
                  · {{ g.subtitle }}
                </p>
                <div v-for="a in g.agents" :key="a.id" class="group flex items-center">
                  <button
                    type="button"
                    :class="[
                      'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      selectedHandle === a.name
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                        : 'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700',
                    ]"
                    @click="openPerson(a.name)"
                  >
                    <span :class="['h-2 w-2 shrink-0 rounded-full', statusFor(a).dot]" />
                    <Avatar :name="a.display_name || a.name" :src="a.avatar_url" size="sm" />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="truncate font-medium">{{ a.display_name || a.name }}</span>
                        <span :class="['shrink-0 text-[10px]', statusFor(a).cls]">{{ statusFor(a).text }}</span>
                      </div>
                      <p class="truncate font-mono text-[11px] text-muted">@{{ a.name }}</p>
                      <p v-if="a.description" class="truncate text-[11px] text-gray-500">{{ a.description }}</p>
                      <p class="truncate text-[11px] text-muted">{{ runtimeLine(a) }}</p>
                    </div>
                  </button>
                  <!-- server owner 可移出他人 agent（踢出而非销毁，重指属主自有 server） -->
                  <button
                    v-if="canKick(a)"
                    type="button"
                    class="ml-1 hidden shrink-0 rounded-md px-1.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 group-hover:block dark:text-red-400 dark:hover:bg-red-900/30"
                    :disabled="kickingId === a.id"
                    title="移出服务器（agent 回到属主自有的服务器，不会被删除）"
                    @click="kickAgent(a)"
                  >
                    {{ kickingId === a.id ? "移出中…" : "移出" }}
                  </button>
                </div>
              </SidebarSection>
            </div>

            <SidebarSection title="成员" persist-key="people.page.humans" :count="filteredMembers.length">
              <template v-if="isServerOwner" #action>
                <button
                  type="button"
                  class="rounded-md p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                  :class="invitePanelOpen && 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                  title="邀请 / 添加成员"
                  @click="invitePanelOpen = !invitePanelOpen"
                >
                  <UserPlus class="h-3.5 w-3.5" />
                </button>
              </template>

              <!-- owner 邀请面板：handle 直拉 + 邀请链接 CRUD（融合自原设置页） -->
              <div
                v-if="isServerOwner && invitePanelOpen"
                class="mb-2 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/60"
              >
                <div>
                  <p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">按 handle 添加</p>
                  <div class="flex items-center gap-1.5">
                    <input
                      v-model="addHandle"
                      type="text"
                      placeholder="@handle"
                      class="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                      @keydown.enter="addMember"
                    />
                    <button
                      type="button"
                      class="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                      :disabled="addBusy || !addHandle.trim()"
                      @click="addMember"
                    >
                      {{ addBusy ? "…" : "添加" }}
                    </button>
                  </div>
                </div>
                <div class="border-t border-gray-200 pt-2 dark:border-gray-700">
                  <div class="mb-1 flex items-center justify-between">
                    <p class="text-[10px] font-semibold uppercase tracking-wider text-muted">邀请链接</p>
                    <button
                      type="button"
                      class="rounded px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
                      :disabled="inviteBusy"
                      @click="createInvite"
                    >
                      {{ inviteBusy ? "生成中…" : "生成链接" }}
                    </button>
                  </div>
                  <div
                    v-for="inv in activeInvites"
                    :key="inv.token"
                    class="mb-1 flex items-center gap-1.5 rounded bg-white p-1.5 dark:bg-gray-900"
                  >
                    <code class="min-w-0 flex-1 truncate text-[10px] text-gray-600 dark:text-gray-300">{{ inviteUrl(inv.token) }}</code>
                    <span class="shrink-0 text-[10px] text-muted">
                      {{ inv.uses }}{{ inv.max_uses != null ? "/" + inv.max_uses : "" }} 次
                    </span>
                    <button
                      type="button"
                      class="shrink-0 rounded px-1 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                      :title="copiedToken === inv.token ? '已复制' : '复制'"
                      @click="copyInvite(inv.token)"
                    >
                      <Check v-if="copiedToken === inv.token" class="inline h-3 w-3" />
                      <template v-else>复制</template>
                    </button>
                    <button
                      type="button"
                      class="shrink-0 rounded px-1 py-0.5 text-[10px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                      title="吊销"
                      @click="revokeInvite(inv.token)"
                    >
                      <X class="h-3 w-3" />
                    </button>
                  </div>
                  <p v-if="activeInvites.length === 0" class="text-[10px] text-muted">还没有有效的邀请链接</p>
                </div>
              </div>

              <p v-if="filteredMembers.length === 0" class="px-2 text-xs text-muted">没有匹配的成员</p>
              <div v-for="m in filteredMembers" :key="m.user_id" class="group flex items-center">
                <button
                  type="button"
                  :class="[
                    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    selectedHandle === m.handle
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                      : 'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700',
                  ]"
                  @click="openPerson(m.handle)"
                >
                  <Avatar :name="m.display_name || m.handle" :src="m.avatar_url" size="sm" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate">
                      {{ m.display_name || m.handle }}
                      <span v-if="m.user_id === authStore.user?.id" class="text-[10px] text-muted">（我）</span>
                    </p>
                    <p class="truncate text-[11px] text-muted">@{{ m.handle }} · {{ roleLabel(m.role) }}</p>
                  </div>
                </button>
                <!-- owner 行内管理：转让所有权 / 移除成员（owner 行不可操作） -->
                <template v-if="isServerOwner && m.role !== 'owner'">
                  <button
                    type="button"
                    class="ml-1 hidden shrink-0 rounded-md px-1.5 py-1 text-xs text-amber-600 hover:bg-amber-50 group-hover:block dark:text-amber-400 dark:hover:bg-amber-900/30"
                    title="转让所有权"
                    @click="transferTarget = m"
                  >
                    <Crown class="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    class="hidden shrink-0 rounded-md px-1.5 py-1 text-xs text-red-600 hover:bg-red-50 group-hover:block dark:text-red-400 dark:hover:bg-red-900/30"
                    title="移出服务器"
                    @click="removeTarget = m"
                  >
                    <X class="h-3.5 w-3.5" />
                  </button>
                </template>
              </div>
            </SidebarSection>
          </template>
        </div>

        <p
          v-if="loaded && !empty"
          class="border-t border-gray-200 px-3 py-2 text-[11px] text-muted dark:border-gray-700"
        >
          {{ footerLabel }}
        </p>
      </div>

      <div v-if="isDesktop" class="hidden min-h-0 min-w-0 flex-1 overflow-hidden p-6 lg:flex lg:flex-col">
        <MemberProfileBody v-if="selectedHandle" :handle="selectedHandle" embedded @deleted="onAgentDeleted" />
        <div v-else class="flex h-full flex-col items-center justify-center text-center">
          <p class="text-sm text-muted">选一个成员看档案</p>
          <p class="mt-1 text-xs text-muted">单击左侧名单即可</p>
        </div>
      </div>
    </div>

    <!-- 移除成员确认（对齐全站 ConfirmDialog 惯例） -->
    <ConfirmDialog
      v-if="removeTarget"
      :title="`移除成员 @${removeTarget.handle}？`"
      message="移除后该成员将失去此服务器的访问权限。"
      confirm-label="移除"
      danger
      @confirm="confirmRemove"
      @cancel="removeTarget = null"
    />
    <!-- 转让所有权确认：对方成为 owner，我降为成员 -->
    <ConfirmDialog
      v-if="transferTarget"
      :title="`转让所有权给 @${transferTarget.handle}？`"
      :message="`对方将成为「${serverStore.activeServer?.name}」的所有者，你的角色将变为成员。`"
      :confirm-label="actionBusy ? '转让中…' : '转让'"
      danger
      @confirm="confirmTransfer"
      @cancel="transferTarget = null"
    />
  </div>
</template>
