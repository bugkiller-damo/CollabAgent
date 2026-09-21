<script setup lang="ts">
import type { AgentPresence, PersonChannelMembership, PersonProfile, PersonStats } from "@collabagent/shared";
import { BRIDGE_RUNTIME_IDS, composePresence, PRESENCE_LABEL } from "@collabagent/shared";
import { Crown } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient, apiGet, apiPatch, apiPost } from "../../api";
import { isPresetAvatarUrl } from "../../lib/defaultAvatars";
import { channelPath, parseChannelRoute } from "../../lib/nav";
import { runtimeCatalog, useAgentStore, useAuthStore, useChannelStore, useServerStore, useUiStore } from "../../stores";
import { toast } from "../../stores/toastStore";
import AgentPatrolPanel from "../admin/AgentPatrolPanel.vue";
import AgentWorkspacePanel from "../agent/AgentWorkspacePanel.vue";
import ConfirmDialog from "../ConfirmDialog.vue";
import Avatar from "../ui/Avatar.vue";
import AvatarPresetPicker from "../ui/AvatarPresetPicker.vue";
import Button from "../ui/Button.vue";
import InlineAgentField from "./InlineAgentField.vue";

const LIVE_STATUS_LABEL = PRESENCE_LABEL;

const ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };

const props = withDefaults(
  defineProps<{
    handle: string;
    channelId?: string;
    /** 目录页右栏嵌入（与抽屉壳区分，便于以后加空态/边距） */
    embedded?: boolean;
  }>(),
  { embedded: false },
);

const emit = defineEmits<{
  navigate: [];
  deleted: [handle: string];
}>();

const uiStore = useUiStore();
const agentStore = useAgentStore();
const authStore = useAuthStore();
const channelStore = useChannelStore();
const serverStore = useServerStore();
const router = useRouter();
const route = useRoute();

const profile = ref<PersonProfile | null>(null);
const stats = ref<PersonStats | null>(null);
const loading = ref(false);
const error = ref("");
const expandingChannels = ref(false);
const channelsExpanded = ref(false);
const deleting = ref(false);
const confirmDelete = ref(false);
type AgentTab = "overview" | "workspace" | "channels" | "patrol";
const agentTab = ref<AgentTab>("overview");

const isChannelView = computed(() => !!parseChannelRoute(route.path));

const liveStatus = computed(() => {
  if (!profile.value || profile.value.type !== "agent") return null;
  const live = agentStore.agents[profile.value.handle];
  const presence =
    live?.presence ||
    profile.value.presence ||
    composePresence(profile.value.duty ?? "on", !!profile.value.isOnline, live?.status);
  return LIVE_STATUS_LABEL[presence] || LIVE_STATUS_LABEL.off_duty;
});

const dutyBusy = ref(false);

async function toggleDuty() {
  const p = profile.value;
  if (!p || p.type !== "agent" || !p.ownedByMe || dutyBusy.value) return;
  const next = p.duty === "off" ? "on" : "off";
  if (next === "off") {
    const live = agentStore.agents[p.handle];
    if (live?.status === "working" || live?.status === "starting") {
      if (!window.confirm("当前回合会中止，未完成输出不会代发。确定停班？")) return;
    }
  }
  dutyBusy.value = true;
  try {
    const r = await apiPost<{ duty: "on" | "off"; presence: AgentPresence; isOnline: boolean }>(
      `/api/agents/${p.id}/duty`,
      { duty: next },
    );
    profile.value = { ...p, duty: r.duty, presence: r.presence, isOnline: r.isOnline };
    agentStore.applyPresence({
      agentName: p.handle,
      agentId: p.id,
      duty: r.duty,
      computerOnline: !!p.computer?.online,
      presence: r.presence,
    });
    toast.success(next === "off" ? "已停班" : "开始值班");
  } catch (err: any) {
    toast.error(err?.message || "切换值班失败");
  } finally {
    dutyBusy.value = false;
  }
}

const progressHeadline = computed(() => {
  if (!profile.value || profile.value.type !== "agent") return "";
  return agentStore.progressByAgent[profile.value.handle]?.headline || "";
});

const joinedLabel = computed(() => {
  // agent 的创建时间已移入资料页 dl，头部只保留「加入本频道」（频道语境信息）；
  // 人类档案无 dl，createdAt 回落保留在头部
  const iso =
    profile.value?.type === "agent"
      ? profile.value?.channel?.joinedAt
      : profile.value?.channel?.joinedAt || profile.value?.createdAt;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ymd = d.toISOString().slice(0, 10);
  return profile.value?.channel?.joinedAt ? `加入本频道 ${ymd}` : `加入 ${ymd}`;
});

const createdLabel = computed(() => {
  const iso = profile.value?.createdAt;
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
});

// 档案内跳转（创建人 / 创建的 Agent）：嵌入面板与抽屉壳同读 profileTarget
function openMemberProfile(handle?: string | null) {
  if (handle) uiStore.openProfile({ handle });
}

const lastSpokeLabel = computed(() => {
  const iso = profile.value?.lastMessageAt;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `最近发言于 ${formatRelative(d)}`;
});

function formatRelative(d: Date): string {
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return d.toISOString().slice(0, 10);
}

const displayName = computed(() => profile.value?.displayName || profile.value?.handle || props.handle);

const isSelf = computed(() => {
  const me = authStore.user?.handle;
  return !!me && profile.value?.type === "human" && profile.value.handle === me;
});

const canEditAgent = computed(() => profile.value?.type === "agent" && !!profile.value.ownedByMe);

const runtimeLabel = computed(() => {
  const id = profile.value?.runtime || "claude";
  return runtimeCatalog().find((c) => c.id === id)?.label || id;
});

// Phase 4：bridge runtime 的 entrypoint/model 由创建时 probe 策略锁定，
// 行内编辑（claude 专用选项集）不适用于它们——只读展示。
const isBridgeProfile = computed(() =>
  (BRIDGE_RUNTIME_IDS as readonly string[]).includes(profile.value?.runtime || ""),
);

const modelLabel = computed(() => {
  const id = (profile.value?.model || "sonnet").toLowerCase();
  const names: Record<string, string> = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" };
  return names[id] || profile.value?.model || "Sonnet";
});

function fieldValue(v: string | null | undefined, empty = "未填写"): string {
  const t = (v || "").trim();
  return t || empty;
}

const showStats = computed(() => {
  const s = stats.value;
  if (!s) return false;
  return (
    s.messages > 0 || s.tasksOpen > 0 || s.tasksDone > 0 || typeof s.costUsd === "number" || (s.unmeteredTurns ?? 0) > 0
  );
});

async function load() {
  const h = props.handle.replace(/^@/, "");
  if (!h) {
    profile.value = null;
    stats.value = null;
    return;
  }
  loading.value = true;
  error.value = "";
  channelsExpanded.value = false;
  confirmDelete.value = false;
  agentTab.value = "overview";
  try {
    const params: Record<string, string> = {};
    if (props.channelId) params.channelId = props.channelId;
    // 显式租户语境：人类档案的「创建的 Agent」按当前 server 过滤（频道/统计同口径收窄）
    if (serverStore.activeServerId) params.serverId = serverStore.activeServerId;
    profile.value = await apiGet<PersonProfile>(`/api/people/${encodeURIComponent(h)}`, params);
    try {
      stats.value = await apiGet<PersonStats>(`/api/people/${encodeURIComponent(h)}/stats`, {
        days: "7",
        ...(params.serverId ? { serverId: params.serverId } : {}),
      });
    } catch {
      stats.value = null;
    }
  } catch (err: any) {
    profile.value = null;
    stats.value = null;
    error.value = err?.message || "加载失败";
  } finally {
    loading.value = false;
  }
}

watch(() => [props.handle, props.channelId, serverStore.activeServerId] as const, load, { immediate: true });

function leaveIfOverlay() {
  emit("navigate");
  uiStore.closeProfile();
  uiStore.closeMobileDrawer();
}

function sendMessage() {
  const h = profile.value?.handle || props.handle;
  if (!h) return;
  leaveIfOverlay();
  void router.push("/dm/" + h);
}

function openObserve() {
  const h = profile.value?.handle;
  if (!h) return;
  uiStore.openTerminal(h);
}

function mentionHere() {
  const h = profile.value?.handle;
  if (!h) return;
  uiStore.requestMention(h);
}

function goChannel(name: string) {
  leaveIfOverlay();
  const sid = serverStore.activeServerId;
  void router.push(sid ? channelPath(sid, name) : "/channels/" + name);
}

function goMembership(c: PersonChannelMembership) {
  if (c.type === "dm" && c.peerHandle) {
    leaveIfOverlay();
    void router.push("/dm/" + c.peerHandle);
    return;
  }
  goChannel(c.name);
}

const CHANNEL_KIND_ORDER: Array<PersonChannelMembership["type"]> = ["public", "private", "dm"];
const CHANNEL_KIND_LABEL: Record<string, string> = {
  public: "公开频道",
  private: "私有频道",
  dm: "私信",
};

const channelsByKind = computed(() => {
  const groups: { type: string; label: string; items: PersonChannelMembership[] }[] = [];
  const list = profile.value?.channels || [];
  for (const t of CHANNEL_KIND_ORDER) {
    const items = list.filter((c) => (c.type || "public") === t);
    if (items.length) groups.push({ type: t || "public", label: CHANNEL_KIND_LABEL[t || "public"], items });
  }
  return groups;
});

function membershipTitle(c: PersonChannelMembership): string {
  if (c.type === "dm") return c.peerHandle ? `@${c.peerHandle}` : "私信";
  return `#${c.name}`;
}

function membershipKindBadge(c: PersonChannelMembership): { text: string; cls: string } {
  if (c.type === "private")
    return { text: "私有", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" };
  if (c.type === "dm") return { text: "私信", cls: "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300" };
  return { text: "公开", cls: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" };
}

function goComputer() {
  const id = profile.value?.computer?.id;
  if (!id) return;
  leaveIfOverlay();
  void router.push("/computers/" + id);
}

function goEdit() {
  if (!isSelf.value) return;
  leaveIfOverlay();
  void router.push("/settings/profile");
}

// 行内编辑：单字段 PATCH 成功后本地合并，不整页 reload（避免「加载中」闪烁）
function applyField(field: string, value: string) {
  const p = profile.value;
  if (!p) return;
  profile.value = { ...p, [field]: value };
  // 头像/显示名同步频道成员缓存——成员面板/AgentStatusBar/消息行头像都读
  // membersByChannelId，本地即写不依赖 WS 回环（server profile:update 到达后幂等重放）
  if (p.type === "agent" && (field === "avatarUrl" || field === "displayName")) {
    channelStore.applyMemberProfile({
      memberType: "agent",
      memberId: p.id,
      ...(field === "avatarUrl" ? { avatarUrl: value || null } : { displayName: value }),
    });
  }
}

// 头部头像即选择器（自己的 agent）：点选即存，"" = 恢复字母兜底
async function saveAvatar(url: string) {
  const p = profile.value;
  if (!p || p.type !== "agent" || !p.ownedByMe) return;
  try {
    await apiPatch(`/api/agents/${p.id}`, { avatarUrl: url });
    applyField("avatarUrl", url);
    toast.success("头像已更新");
  } catch (err: any) {
    toast.error(err?.message || "头像更新失败");
  }
}

async function handleDelete() {
  const p = profile.value;
  if (!p || deleting.value) return;
  confirmDelete.value = false;
  deleting.value = true;
  try {
    await apiClient(`/api/agents/${p.id}`, { method: "DELETE" });
    emit("deleted", p.handle);
    uiStore.closeProfile();
    toast.success(`已删除 @${p.handle}`);
  } catch (err: any) {
    toast.error(err?.message || "删除失败");
  } finally {
    deleting.value = false;
  }
}

async function expandChannels() {
  const h = profile.value?.handle;
  if (!h || expandingChannels.value) return;
  expandingChannels.value = true;
  try {
    const params: Record<string, string> = { channels: "all" };
    if (props.channelId) params.channelId = props.channelId;
    const full = await apiGet<PersonProfile>(`/api/people/${encodeURIComponent(h)}`, params);
    if (profile.value && full.handle === profile.value.handle) {
      profile.value = {
        ...profile.value,
        channels: full.channels,
        channelsHasMore: false,
        channelsCapped: full.channelsCapped,
      };
      channelsExpanded.value = true;
    }
  } catch {
    /* keep preview */
  } finally {
    expandingChannels.value = false;
  }
}
</script>

<template>
  <div :class="embedded ? 'flex h-full min-h-0 flex-col overflow-hidden' : ''">
    <p v-if="loading" class="py-8 text-center text-sm text-muted">加载中…</p>
    <p v-else-if="error" class="py-8 text-center text-sm text-red-400">{{ error }}</p>

    <template v-else-if="profile">
      <div class="min-h-0 flex-1 overflow-y-auto" :class="embedded && agentTab === 'workspace' ? 'flex flex-col' : ''">
      <div class="flex items-start gap-3">
        <AvatarPresetPicker
          v-if="canEditAgent"
          :current="profile.avatarUrl"
          :letter-name="displayName"
          size="lg"
          @select="saveAvatar"
        />
        <Avatar v-else :name="displayName" :src="profile.avatarUrl || undefined" size="lg" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="truncate text-base font-semibold text-ink">{{ displayName }}</h2>
            <span
              :class="[
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                profile.type === 'agent'
                  ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
                  : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
              ]"
            >
              {{ profile.type === "agent" ? "Agent" : "Human" }}
            </span>
            <span
              v-if="profile.channel?.isManager"
              title="本频道经理，可派单"
              class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900 dark:text-amber-300"
            >
              <Crown class="mr-0.5 inline h-3 w-3" aria-hidden="true" /> 经理
            </span>
          </div>
          <p class="mt-0.5 text-xs text-muted">
            @{{ profile.handle }}
            <template v-if="liveStatus">
              · <span :class="liveStatus.cls">{{ liveStatus.text }}</span>
            </template>
          </p>
          <p v-if="profile.type === 'human' && profile.description" class="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {{ profile.description }}
          </p>
          <p v-if="joinedLabel" class="mt-1 text-xs text-muted">{{ joinedLabel }}</p>
          <p v-if="lastSpokeLabel" class="mt-0.5 text-xs text-muted">{{ lastSpokeLabel }}</p>
          <p v-if="profile.channel?.role" class="mt-0.5 text-xs text-muted">
            本频道角色：{{ ROLE_LABEL[profile.channel.role] || profile.channel.role }}
          </p>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap gap-2">
        <Button size="sm" @click="sendMessage">发消息</Button>
        <Button v-if="profile.type === 'agent'" size="sm" variant="secondary" @click="openObserve">打开观察</Button>
        <Button v-if="isChannelView" size="sm" variant="ghost" @click="mentionHere">在此 @</Button>
        <Button v-if="isSelf" size="sm" variant="ghost" @click="goEdit">编辑资料</Button>
      </div>

      <section v-if="progressHeadline" class="mt-5">
        <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">当前状态</h3>
        <p class="text-sm text-blue-700 dark:text-blue-300">正在{{ progressHeadline }}…</p>
      </section>

      <section v-if="showStats" class="mt-5">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">近 7 天</h3>
        <div class="flex flex-wrap gap-2">
          <span class="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            {{ stats?.messages ?? 0 }} 条消息
          </span>
          <span class="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            {{ stats?.tasksOpen ?? 0 }} 进行中
          </span>
          <span class="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            {{ stats?.tasksDone ?? 0 }} 已完成
          </span>
          <span
            v-if="typeof stats?.costUsd === 'number'"
            class="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300"
          >
            ${{ stats.costUsd.toFixed(2) }}
          </span>
          <!-- §14.2：USD 未计量不等于免费——明示 token 用量而非 $0 -->
          <span
            v-if="(stats?.unmeteredTurns ?? 0) > 0"
            class="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            :title="`${stats?.unmeteredTurns} 个回合无 USD 计量`"
          >
            {{ stats?.totalTokens ? `${stats.totalTokens.toLocaleString()} tokens · ` : "" }}USD 未计量
          </span>
        </div>
      </section>

      <section
        v-if="profile.type === 'agent'"
        :class="embedded && agentTab === 'workspace' ? 'mt-5 flex min-h-0 flex-1 flex-col' : 'mt-5'"
      >
        <div class="mb-3 flex gap-1 overflow-x-auto border-b border-line">
          <button
            type="button"
            :class="[
              'shrink-0 border-b-2 px-3 py-1.5 text-xs',
              agentTab === 'overview'
                ? 'border-blue-500 font-medium text-ink'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200',
            ]"
            @click="agentTab = 'overview'"
          >
            资料
          </button>
          <button
            type="button"
            :class="[
              'shrink-0 border-b-2 px-3 py-1.5 text-xs',
              agentTab === 'channels'
                ? 'border-blue-500 font-medium text-ink'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200',
            ]"
            @click="agentTab = 'channels'"
          >
            频道
          </button>
          <button
            v-if="canEditAgent"
            type="button"
            :class="[
              'shrink-0 border-b-2 px-3 py-1.5 text-xs',
              agentTab === 'workspace'
                ? 'border-blue-500 font-medium text-ink'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200',
            ]"
            @click="agentTab = 'workspace'"
          >
            工作区
          </button>
          <button
            v-if="canEditAgent"
            type="button"
            :class="[
              'shrink-0 border-b-2 px-3 py-1.5 text-xs',
              agentTab === 'patrol'
                ? 'border-blue-500 font-medium text-ink'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200',
            ]"
            @click="agentTab = 'patrol'"
          >
            巡检
          </button>
        </div>

        <div v-show="agentTab === 'overview'">
        <dl class="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
          <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">显示名称</dt>
            <dd class="min-w-0 text-sm text-gray-800 dark:text-gray-200">
              <InlineAgentField
                :agent-id="profile.id"
                field="displayName"
                :value="profile.displayName || ''"
                :editable="canEditAgent"
                @saved="applyField('displayName', $event)"
              >
                <span class="min-w-0">{{ fieldValue(profile.displayName, profile.handle) }}</span>
              </InlineAgentField>
            </dd>
          </div>
          <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">Agent 名称</dt>
            <dd class="min-w-0 break-all font-mono text-sm text-gray-800 dark:text-gray-200">@{{ profile.handle }}</dd>
          </div>
          <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">描述</dt>
            <dd class="min-w-0 text-sm text-gray-800 dark:text-gray-200">
              <InlineAgentField
                :agent-id="profile.id"
                field="description"
                :value="profile.description || ''"
                :editable="canEditAgent"
                @saved="applyField('description', $event)"
              >
                <span :class="['min-w-0 whitespace-pre-wrap', !profile.description?.trim() && 'text-muted']">
                  {{ fieldValue(profile.description) }}
                </span>
              </InlineAgentField>
            </dd>
          </div>
          <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">运行时 CLI</dt>
            <dd class="min-w-0 text-sm text-gray-800 dark:text-gray-200">
              <InlineAgentField
                :agent-id="profile.id"
                field="runtime"
                :value="profile.runtime || 'claude'"
                :editable="canEditAgent && !isBridgeProfile"
                kind="select"
                :options="[{ value: 'claude', label: 'Claude' }]"
                :extra-patch="{ model: profile.model || 'sonnet' }"
                @saved="applyField('runtime', $event)"
              >
                <span class="min-w-0">
                  {{ runtimeLabel }}
                  <span class="ml-1 text-xs text-muted">{{ profile.runtime || "claude" }}</span>
                </span>
              </InlineAgentField>
            </dd>
          </div>
          <div v-if="profile.entrypoint" class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">Entrypoint</dt>
            <dd class="min-w-0 break-all font-mono text-sm text-gray-800 dark:text-gray-200">{{ profile.entrypoint }}</dd>
          </div>
          <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">模型</dt>
            <dd class="min-w-0 text-sm text-gray-800 dark:text-gray-200">
              <InlineAgentField
                :agent-id="profile.id"
                field="model"
                :value="(profile.model || 'sonnet').toLowerCase()"
                :editable="canEditAgent && !isBridgeProfile"
                kind="select"
                :options="[
                  { value: 'sonnet', label: 'Sonnet' },
                  { value: 'opus', label: 'Opus' },
                  { value: 'haiku', label: 'Haiku' },
                ]"
                :extra-patch="{ runtime: profile.runtime || 'claude' }"
                @saved="applyField('model', $event)"
              >
                <span class="min-w-0">
                  {{ modelLabel }}
                  <span class="ml-1 text-xs text-muted">{{ profile.model || "sonnet" }}</span>
                </span>
              </InlineAgentField>
            </dd>
          </div>
          <!-- 自定义头像 URL：仅当当前值非内置预设时显示（预设/字母走头部头像选择器） -->
          <div
            v-if="profile.avatarUrl && !isPresetAvatarUrl(profile.avatarUrl)"
            class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5"
          >
            <dt class="text-xs text-muted">头像 URL</dt>
            <dd class="min-w-0 text-sm text-gray-800 dark:text-gray-200">
              <InlineAgentField
                :agent-id="profile.id"
                field="avatarUrl"
                :value="profile.avatarUrl"
                :editable="canEditAgent"
                @saved="applyField('avatarUrl', $event)"
              >
                <span class="min-w-0 break-all">{{ profile.avatarUrl }}</span>
              </InlineAgentField>
            </dd>
          </div>
          <div v-if="profile.computer" class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">跑在</dt>
            <dd class="min-w-0">
              <button
                type="button"
                class="text-left text-sm text-blue-600 hover:underline dark:text-blue-400"
                @click="goComputer"
              >
                {{ profile.computer.name }}
                <span :class="['ml-1 text-xs', profile.computer.online ? 'text-green-500' : 'text-muted']">
                  {{ profile.computer.online ? "在线" : "离线" }}
                </span>
              </button>
            </dd>
          </div>
          <div v-if="profile.createdBy" class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">创建人</dt>
            <dd class="min-w-0">
              <button
                type="button"
                class="flex items-center gap-2 text-left"
                @click="openMemberProfile(profile.createdBy?.handle)"
              >
                <Avatar
                  :name="profile.createdBy.displayName || profile.createdBy.handle"
                  :src="profile.createdBy.avatarUrl || undefined"
                  size="sm"
                />
                <span class="min-w-0 text-sm text-gray-800 dark:text-gray-200">
                  {{ profile.createdBy.displayName || profile.createdBy.handle }}
                  <span class="ml-1 text-xs text-muted">@{{ profile.createdBy.handle }}</span>
                </span>
              </button>
            </dd>
          </div>
          <div v-if="createdLabel" class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
            <dt class="text-xs text-muted">创建时间</dt>
            <dd class="min-w-0 text-sm text-gray-800 dark:text-gray-200">{{ createdLabel }}</dd>
          </div>
        </dl>
        <section v-if="canEditAgent" class="mt-5">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">值班</h3>
          <p class="mb-2 text-xs text-gray-500">停班后仍是成员，只是不接 @ / 巡检 / 分诊。进程不会被拉起。</p>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="secondary" :loading="dutyBusy" @click="toggleDuty">
              {{ profile.duty === "off" ? "开始值班" : "停班" }}
            </Button>
            <button type="button" class="text-xs text-blue-600 hover:underline dark:text-blue-400" @click="goComputer">
              去计算机页
            </button>
          </div>
        </section>
        <section v-if="canEditAgent" class="mt-6 border-t border-red-200 pt-4 dark:border-red-900/50">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-red-500">危险操作</h3>
          <p class="mb-3 text-xs text-muted">将移除该 Agent 及其频道成员关系，历史消息保留。</p>
          <Button variant="danger" size="sm" :disabled="deleting" @click="confirmDelete = true">删除此 Agent</Button>
        </section>
        </div>

        <div v-show="agentTab === 'channels'" class="space-y-4">
          <p v-if="profile.channels.length === 0" class="text-sm text-muted">暂无可见频道或私信</p>
          <div v-for="g in channelsByKind" :key="g.type">
            <h4 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {{ g.label }} · {{ g.items.length }}
            </h4>
            <ul class="space-y-1">
              <li v-for="c in g.items" :key="c.id">
                <button
                  type="button"
                  class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                  @click="goMembership(c)"
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <span class="truncate text-sm text-gray-800 dark:text-gray-200">{{ membershipTitle(c) }}</span>
                      <span :class="['shrink-0 rounded px-1 py-px text-[10px]', membershipKindBadge(c).cls]">
                        {{ membershipKindBadge(c).text }}
                      </span>
                      <span v-if="c.isManager" class="shrink-0 text-[10px] text-amber-600"><Crown class="mr-0.5 inline h-3 w-3" aria-hidden="true" /> 经理</span>
                    </div>
                    <p v-if="c.description?.trim()" class="mt-0.5 line-clamp-2 text-xs text-muted">
                      {{ c.description }}
                    </p>
                    <p v-else-if="c.type === 'dm'" class="mt-0.5 text-xs text-muted">一对一私信</p>
                  </div>
                </button>
              </li>
            </ul>
          </div>
          <button
            v-if="profile.channelsHasMore && !channelsExpanded"
            type="button"
            class="text-xs text-blue-600 hover:underline dark:text-blue-400"
            :disabled="expandingChannels"
            @click="expandChannels"
          >
            {{ expandingChannels ? "加载中…" : "查看全部" }}
          </button>
          <p v-else-if="profile.channelsCapped" class="text-xs text-muted">已显示前 200 个</p>
        </div>

        <AgentWorkspacePanel
          v-if="canEditAgent"
          v-show="agentTab === 'workspace'"
          class="min-h-0 flex-1"
          :agent-id="profile.id"
          :agent-name="profile.handle"
          :computer-online="!!profile.computer?.online"
        />

        <AgentPatrolPanel
          v-if="canEditAgent"
          v-show="agentTab === 'patrol'"
          :agent="{ id: profile.id, name: profile.handle }"
          embedded
        />
      </section>

      <section v-if="profile.channel?.isManager" class="mt-5">
        <p class="text-sm text-amber-700 dark:text-amber-300">本频道经理，可派单</p>
      </section>

      <!-- 人类档案：该用户在当前 server 创建的 agent 列表（点击跳转 agent 档案） -->
      <section v-if="profile.type === 'human' && (profile.agents?.length ?? 0) > 0" class="mt-5">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          创建的 Agent · {{ profile.agents!.length }}
        </h3>
        <ul class="space-y-1">
          <li v-for="a in profile.agents" :key="a.id">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
              @click="openMemberProfile(a.handle)"
            >
              <Avatar :name="a.displayName || a.handle" :src="a.avatarUrl || undefined" size="sm" />
              <span class="min-w-0 truncate text-sm text-gray-800 dark:text-gray-200">
                {{ a.displayName || a.handle }}
              </span>
              <span class="ml-auto shrink-0 text-xs text-muted">@{{ a.handle }}</span>
            </button>
          </li>
        </ul>
      </section>

      <section v-if="profile.type !== 'agent'" class="mt-5 space-y-4">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">所在频道</h3>
        <p v-if="profile.channels.length === 0" class="text-sm text-muted">暂无可见频道或私信</p>
        <div v-for="g in channelsByKind" :key="g.type">
          <h4 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {{ g.label }} · {{ g.items.length }}
          </h4>
          <ul class="space-y-1">
            <li v-for="c in g.items" :key="c.id">
              <button
                type="button"
                class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                @click="goMembership(c)"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-sm text-gray-800 dark:text-gray-200">{{ membershipTitle(c) }}</span>
                    <span :class="['shrink-0 rounded px-1 py-px text-[10px]', membershipKindBadge(c).cls]">
                      {{ membershipKindBadge(c).text }}
                    </span>
                    <span v-if="c.isManager" class="shrink-0 text-[10px] text-amber-600"><Crown class="mr-0.5 inline h-3 w-3" aria-hidden="true" /> 经理</span>
                  </div>
                  <p v-if="c.description?.trim()" class="mt-0.5 line-clamp-2 text-xs text-muted">
                    {{ c.description }}
                  </p>
                  <p v-else-if="c.type === 'dm'" class="mt-0.5 text-xs text-muted">一对一私信</p>
                </div>
              </button>
            </li>
          </ul>
        </div>
        <button
          v-if="profile.channelsHasMore && !channelsExpanded"
          type="button"
          class="text-xs text-blue-600 hover:underline dark:text-blue-400"
          :disabled="expandingChannels"
          @click="expandChannels"
        >
          {{ expandingChannels ? "加载中…" : "查看全部" }}
        </button>
        <p v-else-if="profile.channelsCapped" class="text-xs text-muted">已显示前 200 个</p>
      </section>

      <ConfirmDialog
        v-if="confirmDelete"
        :title="`删除 Agent @${profile.handle}`"
        message="将移除该 Agent 及其频道成员关系（历史消息保留）。此操作不可撤销。"
        confirm-label="删除"
        danger
        @confirm="handleDelete"
        @cancel="confirmDelete = false"
      />
      </div>
    </template>
  </div>
</template>
