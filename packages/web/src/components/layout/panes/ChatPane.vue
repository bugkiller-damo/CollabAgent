<script setup lang="ts">
import { Check, ChevronDown, Copy, Link2, LogOut, Pencil, Plus, Trash2, Users } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet, apiPost } from "../../../api";
import { channelPath, lastChannelKey } from "../../../lib/nav";
import { useAuthStore, useChannelStore, useServerStore, useUiStore } from "../../../stores";
import { toast } from "../../../stores/toastStore";
import CreateChannelModal from "../../channel/CreateChannelModal.vue";
import Avatar from "../../ui/Avatar.vue";
import IconButton from "../../ui/IconButton.vue";
import AgentStatusBar from "../AgentStatusBar.vue";
import SidebarSection from "../SidebarSection.vue";

interface DmItem {
  channelId: string;
  peerHandle: string;
  peerName: string;
  peerType: "human" | "agent";
  peerAvatar?: string | null;
  lastContent?: string;
}

interface PeopleItem {
  handle: string;
  displayName: string;
  type: "human" | "agent";
  avatarUrl?: string | null;
}

const channelStore = useChannelStore();
const serverStore = useServerStore();
const authStore = useAuthStore();
const uiStore = useUiStore();
const router = useRouter();
const route = useRoute();

const showCreateChannel = ref(false);
const showPeople = ref(false);
const people = ref<PeopleItem[]>([]);
const dms = ref<DmItem[]>([]);

// ---- server 头（guild 化）----
const showServerMenu = ref(false);
const serverMenuMode = ref<"" | "invite" | "rename">("");
const inviteLink = ref("");
const inviteBusy = ref(false);
const renameValue = ref("");
const renameBusy = ref(false);
const leaveBusy = ref(false);
const deleteBusy = ref(false);
const linkCopied = ref(false);

const activeServer = computed(() => serverStore.activeServer);
const isOwner = computed(() => activeServer.value?.role === "owner");
// member 可退任意 server（含广场——退出后卡片回发现面可再加入）；owner 恒拒退
const canLeave = computed(() => !!activeServer.value && !isOwner.value);
// 删除入口仅 owner 可见；is_public（广场，等价旧 isDefault 口径）后端拒删，前端直接隐藏。
// 自建 server 一律可删（2026-09-19 personal 特例取消：所有自建 server 生命周期同口径）
const canDelete = computed(
  () => !!activeServer.value && isOwner.value && !activeServer.value.isDefault && !activeServer.value.is_public,
);

const user = computed(() => authStore.user);
const activeDmHandle = computed(() =>
  route.path.startsWith("/dm/") ? decodeURIComponent(route.path.split("/")[2] || "") : "",
);

const channels = computed(() => channelStore.channels);
const activeChannelName = computed(() => channelStore.activeChannelName);
const activeServerId = computed(() => serverStore.activeServerId);

function unreadFor(name: string): number {
  return channelStore.unreadCounts[channelStore.unreadKeyFor(activeServerId.value, name)] || 0;
}

function loadDms() {
  apiGet<{ dms: DmItem[] }>("/api/channels/dms")
    .then((d) => {
      dms.value = d.dms || [];
    })
    .catch(() => {});
}

// 私信列表按活跃 server 过滤（后端读 x-server-id）：切 server 也要重拉，
// 否则仍显示上一个 server 语境下的会话列表
watch([() => route.path, () => serverStore.activeServerId], () => loadDms(), { immediate: true });

// 对端资料变更（profile:update → membersVersion 递增）时重拉——peerName/peerAvatar 是
// 列表快照字段，不刷新会滞留旧值
watch(
  () => channelStore.membersVersion,
  () => loadDms(),
);

async function openPeoplePicker() {
  showPeople.value = !showPeople.value;
  if (people.value.length > 0) return;
  const list: PeopleItem[] = [];
  const sid = activeServerId.value;
  try {
    const a = await apiGet<{ agents: any[] }>("/api/agents");
    // agent 是 server 级记录：私信候选只列活跃 server 的 agent（跨 server 同名不混）
    for (const x of a.agents || []) {
      if (sid && String(x.server_id) !== sid) continue;
      list.push({ handle: x.name, displayName: x.display_name || x.name, type: "agent", avatarUrl: x.avatar_url });
    }
  } catch {}
  try {
    const s = await apiGet<any>("/api/server/info", sid ? { serverId: sid } : undefined);
    for (const h of s.humans || []) {
      if (h.handle === user.value?.handle) continue;
      list.push({ handle: h.handle, displayName: h.display_name || h.handle, type: "human", avatarUrl: h.avatar_url });
    }
  } catch {}
  people.value = list;
}

function startDm(handle: string) {
  showPeople.value = false;
  uiStore.closeMobileDrawer();
  router.push("/dm/" + handle);
}

function isPriv(c: any): boolean {
  return c.type === "private" || c.visibility === "private";
}

const publicChannels = computed(() => channels.value.filter((c: any) => !isPriv(c)));
const privateChannels = computed(() => channels.value.filter((c: any) => isPriv(c)));

function rememberLast(name: string) {
  try {
    if (activeServerId.value) localStorage.setItem(lastChannelKey(activeServerId.value), name);
  } catch {
    /* ignore */
  }
}

function onSelectChannel(ch: any) {
  channelStore.setActiveChannel(ch.name);
  rememberLast(ch.name);
  uiStore.closeMobileDrawer();
  const sid = activeServerId.value;
  router.push(sid ? channelPath(sid, ch.name) : "/channels/" + ch.name);
}

function onCreated(name: string) {
  channelStore.setActiveChannel(name);
  rememberLast(name);
  uiStore.closeMobileDrawer();
  const sid = activeServerId.value;
  router.push(sid ? channelPath(sid, name) : "/channels/" + name);
}

async function joinChannel(ch: any) {
  try {
    await channelStore.joinChannel(ch.id);
  } catch (e: any) {
    toast.error("加入频道失败：" + (e?.message || "网络错误"));
  }
}

// ---- server 菜单动作 ----
function openServerMenu() {
  showServerMenu.value = !showServerMenu.value;
  serverMenuMode.value = "";
  inviteLink.value = "";
  renameValue.value = activeServer.value?.name || "";
  linkCopied.value = false;
}

async function createInvite() {
  const sid = activeServerId.value;
  if (!sid) return;
  inviteBusy.value = true;
  try {
    const r = await apiPost<{ token: string }>(`/api/orgs/${sid}/invites`, {});
    inviteLink.value = `${window.location.origin}/invite/${r.token}`;
  } catch (e: any) {
    toast.error("创建邀请链接失败：" + (e?.message || "网络错误"));
  } finally {
    inviteBusy.value = false;
  }
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    linkCopied.value = true;
  } catch {
    toast.error("复制失败，请手动复制");
  }
}

async function submitRename() {
  const sid = activeServerId.value;
  const name = renameValue.value.trim();
  if (!sid || !name) return;
  renameBusy.value = true;
  try {
    await serverStore.renameServer(sid, name);
    serverMenuMode.value = "";
  } catch (e: any) {
    toast.error("重命名失败：" + (e?.message || "网络错误"));
  } finally {
    renameBusy.value = false;
  }
}

async function submitLeave() {
  const s = activeServer.value;
  if (!s) return;
  if (!window.confirm(`确定退出「${s.name}」吗？`)) return;
  leaveBusy.value = true;
  try {
    await serverStore.leaveServer(s.id);
    showServerMenu.value = false;
    const next = serverStore.activeServerId;
    if (next) void router.push(channelPath(next, await channelStore.resolveLandingChannel(next)));
  } catch (e: any) {
    toast.error("退出失败：" + (e?.message || "网络错误"));
  } finally {
    leaveBusy.value = false;
  }
}

async function submitDelete() {
  const s = activeServer.value;
  if (!s) return;
  if (
    !window.confirm(
      `确定删除「${s.name}」吗？该服务器下的频道、消息、成员与邀请链接将一并清除，不可恢复。` +
        (s.agentCount > 0 ? `\n注意：${s.agentCount} 个 agent 也将一并删除。` : ""),
    )
  )
    return;
  deleteBusy.value = true;
  try {
    await serverStore.deleteServer(s.id);
    showServerMenu.value = false;
    const next = serverStore.activeServerId;
    if (next) void router.push(channelPath(next, await channelStore.resolveLandingChannel(next)));
    else void router.push("/");
  } catch (e: any) {
    toast.error("删除失败：" + (e?.message || "网络错误"));
  } finally {
    deleteBusy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- server 头：名称 + 管理菜单（邀请/成员/改名/退出） -->
    <div v-if="activeServer" class="relative shrink-0 border-b border-gray-200 dark:border-gray-700">
      <button
        type="button"
        class="flex w-full items-center justify-between gap-1 px-3 py-2.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700/60"
        @click="openServerMenu"
      >
        <span class="min-w-0 truncate text-sm font-semibold text-ink">{{ activeServer.name }}</span>
        <ChevronDown class="h-4 w-4 shrink-0 text-muted" />
      </button>
      <div
        v-if="showServerMenu"
        class="absolute left-2 right-2 top-full z-30 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
      >
        <template v-if="serverMenuMode === ''">
          <button
            v-if="isOwner"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            @click="serverMenuMode = 'invite'; void createInvite()"
          >
            <Link2 class="h-4 w-4" /> 邀请成员
          </button>
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            @click="router.push('/people'); showServerMenu = false"
          >
            <Users class="h-4 w-4" /> 成员管理
          </button>
          <button
            v-if="isOwner"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            @click="serverMenuMode = 'rename'"
          >
            <Pencil class="h-4 w-4" /> 重命名服务器
          </button>
          <button
            v-if="canLeave"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
            :disabled="leaveBusy"
            @click="submitLeave"
          >
            <LogOut class="h-4 w-4" /> {{ leaveBusy ? "退出中…" : "退出服务器" }}
          </button>
          <button
            v-if="canDelete"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
            :disabled="deleteBusy"
            @click="submitDelete"
          >
            <Trash2 class="h-4 w-4" /> {{ deleteBusy ? "删除中…" : "删除服务器" }}
          </button>
          <p v-if="!isOwner && !canLeave" class="px-3 py-1.5 text-xs text-muted">没有可用的管理操作</p>
        </template>

        <template v-else-if="serverMenuMode === 'invite'">
          <p class="px-3 pb-1 pt-2 text-xs text-muted">分享此链接邀请成员加入「{{ activeServer.name }}」</p>
          <div v-if="inviteBusy" class="px-3 py-2 text-xs text-muted">生成中…</div>
          <div v-else class="flex items-center gap-1 px-3 py-1">
            <input
              :value="inviteLink"
              readonly
              class="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <IconButton label="复制" tooltip="复制链接" class="h-7 w-7" @click="copyInvite">
              <Check v-if="linkCopied" class="h-3.5 w-3.5 text-green-500" />
              <Copy v-else class="h-3.5 w-3.5" />
            </IconButton>
          </div>
          <button class="w-full px-3 py-1.5 text-left text-xs text-muted hover:text-ink" @click="serverMenuMode = ''">
            ← 返回
          </button>
        </template>

        <template v-else-if="serverMenuMode === 'rename'">
          <div class="space-y-2 px-3 py-2">
            <input
              v-model="renameValue"
              type="text"
              maxlength="100"
              class="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              @keydown.enter="submitRename"
            />
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-md bg-blue-600 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                :disabled="renameBusy"
                @click="submitRename"
              >
                {{ renameBusy ? "保存中…" : "保存" }}
              </button>
              <button class="flex-1 rounded-md bg-gray-100 py-1 text-xs text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300" @click="serverMenuMode = ''">
                取消
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <nav class="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
      <SidebarSection title="频道" persist-key="chat.public" :count="publicChannels.length">
        <template #action>
          <!-- 建频道已收敛到 server owner（POST /api/channels → isOrgOwner），member 隐藏 -->
          <IconButton v-if="isOwner" label="创建频道" tooltip="创建频道" class="h-6 w-6" @click="showCreateChannel = true">
            <Plus class="h-4 w-4" />
          </IconButton>
        </template>
        <div v-for="ch in publicChannels" :key="ch.id" class="group flex items-center">
          <button
            :class="[
              'flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              ch.name === activeChannelName
                ? 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-700 dark:text-white'
                : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white',
            ]"
            @click="onSelectChannel(ch)"
          >
            <span class="flex items-center gap-2 truncate">
              <span class="text-muted">#</span>
              <span class="truncate">{{ ch.name }}</span>
            </span>
            <span v-if="unreadFor(ch.name) > 0" class="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-xs text-white">
              {{ unreadFor(ch.name) }}
            </span>
          </button>
          <button
            v-if="!channelStore.joinedChannels.has(ch.name)"
            class="ml-1 hidden shrink-0 rounded-md px-1.5 py-1 text-xs text-blue-600 hover:bg-blue-50 group-hover:block dark:text-blue-400 dark:hover:bg-blue-900/40"
            @click="joinChannel(ch)"
          >
            加入
          </button>
        </div>
      </SidebarSection>

      <SidebarSection v-if="privateChannels.length > 0" title="私有频道" persist-key="chat.private" :count="privateChannels.length">
        <button
          v-for="ch in privateChannels"
          :key="ch.id"
          :class="[
            'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            ch.name === activeChannelName
              ? 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-700 dark:text-white'
              : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white',
          ]"
          @click="onSelectChannel(ch)"
        >
          <span class="flex items-center gap-2 truncate">
            <span class="shrink-0 text-amber-500" title="私有频道">
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            </span>
            <span class="truncate">{{ ch.name }}</span>
          </span>
          <span v-if="unreadFor(ch.name) > 0" class="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-xs text-white">
            {{ unreadFor(ch.name) }}
          </span>
        </button>
      </SidebarSection>

      <SidebarSection title="私信" persist-key="chat.dms" :count="dms.length">
        <template #action>
          <div class="relative">
            <IconButton label="发起私信" tooltip="发起私信" class="h-6 w-6" @click="openPeoplePicker">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </IconButton>
            <div
              v-if="showPeople"
              class="absolute right-0 top-7 z-30 w-52 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg animate-scale-in origin-top-right dark:border-gray-700 dark:bg-gray-800"
            >
              <div v-if="people.length === 0" class="px-3 py-2 text-xs text-muted">没有可私信的对象</div>
              <button
                v-for="p in people"
                :key="p.type + ':' + p.handle"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                @click="startDm(p.handle)"
              >
                <Avatar :name="p.displayName" :src="p.avatarUrl || undefined" size="sm" />
                <span class="truncate">{{ p.displayName }}</span>
                <span class="ml-auto text-xs text-muted">@{{ p.handle }}</span>
              </button>
            </div>
          </div>
        </template>
        <button
          v-for="d in dms"
          :key="d.channelId"
          :class="[
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            d.peerHandle === activeDmHandle
              ? 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-700 dark:text-white'
              : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white',
          ]"
          @click="startDm(d.peerHandle)"
        >
          <Avatar :name="d.peerName || d.peerHandle" :src="d.peerAvatar || undefined" size="sm" />
          <span class="truncate">{{ d.peerName || d.peerHandle }}</span>
        </button>
        <p v-if="dms.length === 0" class="px-2 py-1 text-xs text-muted">点 + 发起私信</p>
      </SidebarSection>
    </nav>

    <AgentStatusBar />
    <CreateChannelModal v-if="showCreateChannel" :on-close="() => (showCreateChannel = false)" :on-created="onCreated" />
  </div>
</template>
