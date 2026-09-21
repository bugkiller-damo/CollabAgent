<script setup lang="ts">
import { Crown, X } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { apiClient } from "../../api";
import { type ChannelMember, useAuthStore, useChannelStore, useUiStore } from "../../stores";
import { toast } from "../../stores/toastStore";
import Avatar from "../ui/Avatar.vue";
import ChannelInvitePicker from "./ChannelInvitePicker.vue";

const ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };

const props = defineProps<{
  channelId: string;
  onClose: () => void;
}>();

const authStore = useAuthStore();
const channelStore = useChannelStore();
const uiStore = useUiStore();
const currentUserId = computed(() => authStore.user?.id);

// 成员列表直接读 channelStore 缓存（fetchMembers 是唯一写入点）——profile:update
// 广播 / 本地保存的 applyMemberProfile 回写后，本面板随 store 即时刷新头像/显示名
const members = computed<ChannelMember[]>(() => channelStore.membersByChannelId[props.channelId] ?? []);
const loading = ref(true);

function load() {
  loading.value = true;
  channelStore
    .fetchMembers(props.channelId)
    .catch(() => {})
    .finally(() => {
      loading.value = false;
    });
}

onMounted(load);
watch(() => props.channelId, load);

async function handleRemove(m: ChannelMember) {
  if (!confirm(`将 @${m.handle} 移出频道？`)) return;
  try {
    await apiClient(`/api/channels/${props.channelId}/members/${m.member_id}`, { method: "DELETE" });
    load();
  } catch (err: any) {
    toast.error(err?.message || "移除失败");
  }
}

async function handleRole(m: ChannelMember, role: string) {
  try {
    await apiClient(`/api/channels/${props.channelId}/members/${m.member_id}`, { method: "PATCH", body: { role } });
    load();
  } catch (err: any) {
    toast.error(err?.message || "修改失败");
  }
}

async function handleManager(m: ChannelMember, is_manager: boolean) {
  try {
    await apiClient(`/api/channels/${props.channelId}/members/${m.member_id}`, {
      method: "PATCH",
      body: { is_manager },
    });
    load();
  } catch (err: any) {
    toast.error(
      err?.message === "channel already has a manager" ? "该频道已有经理，请先取消原经理" : err?.message || "设置失败",
    );
  }
}

const humans = computed(() => members.value.filter((m) => m.member_type === "human"));
const agents = computed(() => members.value.filter((m) => m.member_type === "agent"));

// 邀请入口只对频道管理员可见（后端 /invite 同口径 canManageChannel）——
// 此前普通成员也能看到输入框但提交必 403
const canInvite = computed(() => {
  const me = members.value.find((m) => m.member_type === "human" && m.member_id === currentUserId.value);
  return me?.role === "owner" || me?.role === "admin";
});

function openProfile(m: ChannelMember) {
  uiStore.openProfile({ handle: m.handle, channelId: props.channelId });
  props.onClose();
}
</script>

<template>
  <aside class="w-60 shrink-0 border-l border-line bg-gray-50 dark:bg-gray-800 flex flex-col">
    <div class="flex items-center justify-between p-3 border-b border-line">
      <span class="text-gray-700 dark:text-gray-300 text-sm font-semibold">成员（{{ members.length }}）</span>
      <button @click="onClose" class="text-muted hover:text-gray-700 dark:hover:text-white text-sm">
        <X class="h-4 w-4" />
      </button>
    </div>

    <div v-if="canInvite" class="p-3 border-b border-line">
      <ChannelInvitePicker :channel-id="channelId" @invited="load" />
    </div>

    <div class="flex-1 overflow-y-auto p-2 space-y-3">
      <p v-if="loading" class="text-muted text-sm text-center py-4">加载中…</p>
      <p v-else-if="members.length === 0" class="text-muted text-sm text-center py-4">暂无成员</p>

      <div v-if="agents.length > 0">
        <div class="text-muted text-xs font-semibold uppercase px-2 mb-1">Agent（{{ agents.length }}）</div>
        <div
          v-for="m in agents"
          :key="m.member_id + m.member_type"
          class="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <div
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
            role="button"
            tabindex="0"
            @click="openProfile(m)"
            @keydown.enter="openProfile(m)"
          >
            <Avatar :name="m.display_name || m.handle" :src="m.avatar_url || undefined" size="sm" />
            <div class="flex-1 min-w-0">
              <div class="text-gray-800 dark:text-gray-200 text-sm truncate">
                {{ m.display_name || m.handle }}<span v-if="m.member_id === currentUserId" class="text-muted"> （你）</span>
              </div>
              <div class="text-muted text-xs truncate">@{{ m.handle }}</div>
            </div>
          </div>
          <select
            v-if="m.member_type === 'human' && m.role !== 'owner'"
            :value="m.role || 'member'"
            @change="handleRole(m, ($event.target as HTMLSelectElement).value)"
            class="text-[10px] bg-transparent text-muted border border-gray-200 dark:border-gray-600 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <span
            v-else-if="m.role && m.role !== 'member'"
            class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300"
          >
            {{ ROLE_LABEL[m.role] || m.role }}
          </span>
          <span
            v-if="m.member_type === 'agent' && m.is_manager"
            title="该频道的经理 agent，可派发任务给其它 agent"
            class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300"
          >
            <Crown class="mr-0.5 inline h-3 w-3" aria-hidden="true" /> 经理
          </span>
          <button
            v-if="m.member_type === 'agent'"
            @click="handleManager(m, !m.is_manager)"
            :title="m.is_manager ? '取消经理身份' : '设为该频道的经理（可派发任务给其它 agent）'"
            class="text-muted hover:text-amber-500 text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap"
          >
            {{ m.is_manager ? "取消经理" : "设为经理" }}
          </button>
          <button
            v-if="m.member_type === 'agent' || (m.role !== 'owner' && m.member_id !== currentUserId)"
            @click="handleRemove(m)"
            :title="m.member_type === 'agent' ? '将 Agent 移出频道' : '移除成员'"
            class="text-muted hover:text-red-500 text-xs opacity-0 group-hover:opacity-100"
          ><X class="h-3.5 w-3.5" /></button>
        </div>
      </div>

      <div v-if="humans.length > 0">
        <div class="text-muted text-xs font-semibold uppercase px-2 mb-1">成员（{{ humans.length }}）</div>
        <div
          v-for="m in humans"
          :key="m.member_id + m.member_type"
          class="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <div
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
            role="button"
            tabindex="0"
            @click="openProfile(m)"
            @keydown.enter="openProfile(m)"
          >
            <Avatar :name="m.display_name || m.handle" :src="m.avatar_url || undefined" size="sm" />
            <div class="flex-1 min-w-0">
              <div class="text-gray-800 dark:text-gray-200 text-sm truncate">
                {{ m.display_name || m.handle }}<span v-if="m.member_id === currentUserId" class="text-muted"> （你）</span>
              </div>
              <div class="text-muted text-xs truncate">@{{ m.handle }}</div>
            </div>
          </div>
          <select
            v-if="m.member_type === 'human' && m.role !== 'owner'"
            :value="m.role || 'member'"
            @change="handleRole(m, ($event.target as HTMLSelectElement).value)"
            class="text-[10px] bg-transparent text-muted border border-gray-200 dark:border-gray-600 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <span
            v-else-if="m.role && m.role !== 'member'"
            class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300"
          >
            {{ ROLE_LABEL[m.role] || m.role }}
          </span>
          <span
            v-if="m.member_type === 'agent' && m.is_manager"
            title="该频道的经理 agent，可派发任务给其它 agent"
            class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300"
          >
            <Crown class="mr-0.5 inline h-3 w-3" aria-hidden="true" /> 经理
          </span>
          <button
            v-if="m.member_type === 'agent'"
            @click="handleManager(m, !m.is_manager)"
            :title="m.is_manager ? '取消经理身份' : '设为该频道的经理（可派发任务给其它 agent）'"
            class="text-muted hover:text-amber-500 text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap"
          >
            {{ m.is_manager ? "取消经理" : "设为经理" }}
          </button>
          <button
            v-if="m.member_type === 'agent' || (m.role !== 'owner' && m.member_id !== currentUserId)"
            @click="handleRemove(m)"
            :title="m.member_type === 'agent' ? '将 Agent 移出频道' : '移除成员'"
            class="text-muted hover:text-red-500 text-xs opacity-0 group-hover:opacity-100"
          ><X class="h-3.5 w-3.5" /></button>
        </div>
      </div>
    </div>
  </aside>
</template>
