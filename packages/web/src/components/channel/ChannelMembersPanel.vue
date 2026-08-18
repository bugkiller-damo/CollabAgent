<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { apiClient, apiGet } from "../../api";
import { useAuthStore } from "../../stores";
import { toast } from "../../stores/toastStore";

interface Member {
  member_id: string;
  member_type: "human" | "agent";
  role: string;
  is_manager?: boolean;
  handle: string;
  display_name?: string;
}

const ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };

const props = defineProps<{
  channelId: string;
  onClose: () => void;
}>();

const authStore = useAuthStore();
const currentUserId = computed(() => authStore.user?.id);

const members = ref<Member[]>([]);
const loading = ref(true);
const inviteHandle = ref("");
const inviteMsg = ref("");
const busy = ref(false);

function load() {
  loading.value = true;
  apiGet<{ members: Member[] }>(`/api/channels/${props.channelId}/members`)
    .then((d) => {
      members.value = d.members || [];
      loading.value = false;
    })
    .catch(() => {
      loading.value = false;
    });
}

onMounted(load);
watch(() => props.channelId, load);

async function handleInvite() {
  const h = inviteHandle.value.trim();
  if (!h) return;
  busy.value = true;
  inviteMsg.value = "";
  try {
    await apiClient(`/api/channels/${props.channelId}/invite`, { method: "POST", body: { handle: h } });
    inviteHandle.value = "";
    inviteMsg.value = "已邀请";
    load();
  } catch (err: any) {
    inviteMsg.value =
      err?.message === "user or agent not found"
        ? "用户/Agent 不存在"
        : err?.message === "already a member"
          ? "已是成员"
          : err?.message || "邀请失败";
  } finally {
    busy.value = false;
  }
}

async function handleRemove(m: Member) {
  if (!confirm(`将 @${m.handle} 移出频道？`)) return;
  try {
    await apiClient(`/api/channels/${props.channelId}/members/${m.member_id}`, { method: "DELETE" });
    load();
  } catch (err: any) {
    toast.error(err?.message || "移除失败");
  }
}

async function handleRole(m: Member, role: string) {
  try {
    await apiClient(`/api/channels/${props.channelId}/members/${m.member_id}`, { method: "PATCH", body: { role } });
    load();
  } catch (err: any) {
    toast.error(err?.message || "修改失败");
  }
}

async function handleManager(m: Member, is_manager: boolean) {
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

function onInviteKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") handleInvite();
}
</script>

<template>
  <aside class="w-60 shrink-0 border-l border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex flex-col">
    <div class="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
      <span class="text-gray-700 dark:text-gray-300 text-sm font-semibold">成员（{{ members.length }}）</span>
      <button @click="onClose" class="text-gray-400 hover:text-gray-700 dark:hover:text-white text-sm">✕</button>
    </div>

    <div class="p-3 border-b border-gray-200 dark:border-gray-700 space-y-1">
      <div class="flex gap-1">
        <input
          type="text"
          :value="inviteHandle"
          @input="inviteHandle = ($event.target as HTMLInputElement).value"
          @keydown="onInviteKeydown"
          placeholder="输入用户名 / Agent名 邀请"
          class="flex-1 min-w-0 text-sm p-1.5 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600"
        />
        <button
          @click="handleInvite"
          :disabled="busy || !inviteHandle.trim()"
          class="px-2 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
        >邀请</button>
      </div>
      <p v-if="inviteMsg" :class="'text-xs ' + (inviteMsg === '已邀请' ? 'text-green-500' : 'text-red-400')">{{ inviteMsg }}</p>
    </div>

    <div class="flex-1 overflow-y-auto p-2 space-y-3">
      <p v-if="loading" class="text-gray-400 text-sm text-center py-4">加载中…</p>
      <p v-else-if="members.length === 0" class="text-gray-400 text-sm text-center py-4">暂无成员</p>

      <div v-if="agents.length > 0">
        <div class="text-gray-400 text-xs font-semibold uppercase px-2 mb-1">Agent（{{ agents.length }}）</div>
        <div
          v-for="m in agents"
          :key="m.member_id + m.member_type"
          class="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <div :class="'w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 ' + (m.member_type === 'agent' ? 'bg-purple-600' : 'bg-gray-500')">
            {{ (m.display_name || m.handle || "?")[0]?.toUpperCase() }}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-gray-800 dark:text-gray-200 text-sm truncate">
              {{ m.display_name || m.handle }}<span v-if="m.member_id === currentUserId" class="text-gray-400"> （你）</span>
            </div>
            <div class="text-gray-400 text-xs truncate">@{{ m.handle }}</div>
          </div>
          <select
            v-if="m.member_type === 'human' && m.role !== 'owner'"
            :value="m.role || 'member'"
            @change="handleRole(m, ($event.target as HTMLSelectElement).value)"
            class="text-[10px] bg-transparent text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-600 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
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
            👔 经理
          </span>
          <button
            v-if="m.member_type === 'agent'"
            @click="handleManager(m, !m.is_manager)"
            :title="m.is_manager ? '取消经理身份' : '设为该频道的经理（可派发任务给其它 agent）'"
            class="text-gray-400 hover:text-amber-500 text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap"
          >
            {{ m.is_manager ? "取消经理" : "设为经理" }}
          </button>
          <button
            v-if="m.member_type === 'agent' || (m.role !== 'owner' && m.member_id !== currentUserId)"
            @click="handleRemove(m)"
            :title="m.member_type === 'agent' ? '将 Agent 移出频道' : '移除成员'"
            class="text-gray-400 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100"
          >✕</button>
        </div>
      </div>

      <div v-if="humans.length > 0">
        <div class="text-gray-400 text-xs font-semibold uppercase px-2 mb-1">成员（{{ humans.length }}）</div>
        <div
          v-for="m in humans"
          :key="m.member_id + m.member_type"
          class="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <div :class="'w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 ' + (m.member_type === 'agent' ? 'bg-purple-600' : 'bg-gray-500')">
            {{ (m.display_name || m.handle || "?")[0]?.toUpperCase() }}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-gray-800 dark:text-gray-200 text-sm truncate">
              {{ m.display_name || m.handle }}<span v-if="m.member_id === currentUserId" class="text-gray-400"> （你）</span>
            </div>
            <div class="text-gray-400 text-xs truncate">@{{ m.handle }}</div>
          </div>
          <select
            v-if="m.member_type === 'human' && m.role !== 'owner'"
            :value="m.role || 'member'"
            @change="handleRole(m, ($event.target as HTMLSelectElement).value)"
            class="text-[10px] bg-transparent text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-600 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
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
            👔 经理
          </span>
          <button
            v-if="m.member_type === 'agent'"
            @click="handleManager(m, !m.is_manager)"
            :title="m.is_manager ? '取消经理身份' : '设为该频道的经理（可派发任务给其它 agent）'"
            class="text-gray-400 hover:text-amber-500 text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap"
          >
            {{ m.is_manager ? "取消经理" : "设为经理" }}
          </button>
          <button
            v-if="m.member_type === 'agent' || (m.role !== 'owner' && m.member_id !== currentUserId)"
            @click="handleRemove(m)"
            :title="m.member_type === 'agent' ? '将 Agent 移出频道' : '移除成员'"
            class="text-gray-400 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100"
          >✕</button>
        </div>
      </div>
    </div>
  </aside>
</template>
