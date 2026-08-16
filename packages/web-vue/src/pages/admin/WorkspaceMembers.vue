<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { apiClient, apiGet, apiPost } from "../../api";
import PageHeader from "../../components/layout/PageHeader.vue";
import Avatar from "../../components/ui/Avatar.vue";
import Button from "../../components/ui/Button.vue";
import Card from "../../components/ui/Card.vue";

interface Org {
  id: string;
  name: string;
  personal: boolean;
  role: string;
  memberCount: number;
  agentCount: number;
}
interface Member {
  user_id: string;
  role: string;
  handle: string;
  display_name?: string;
}
interface Invite {
  token: string;
  role: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
}

const orgs = ref<Org[]>([]);
const org = ref<Org | null>(null);
const members = ref<Member[]>([]);
const invites = ref<Invite[]>([]);
const msg = ref("");
const copied = ref("");

const isOwner = computed(() => org.value?.role === "owner");

function loadMembers(orgId: string) {
  apiGet<{ members: Member[] }>(`/api/orgs/${orgId}/members`)
    .then((d) => {
      members.value = d.members || [];
    })
    .catch(() => {});
}

function loadInvites(orgId: string) {
  apiGet<{ invites: Invite[] }>(`/api/orgs/${orgId}/invites`)
    .then((d) => {
      invites.value = d.invites || [];
    })
    .catch(() => {
      invites.value = [];
    });
}

onMounted(() => {
  apiGet<{ orgs: Org[] }>("/api/orgs")
    .then((d) => {
      const list = d.orgs || [];
      orgs.value = list;
      const def = list.find((o) => !o.personal) || list[0] || null;
      org.value = def;
    })
    .catch(() => {});
});

// 对齐 React 第二个 useEffect([org])：org 变化时加载成员/邀请（org 为 null 时跳过）
watch(org, (o) => {
  if (!o) return;
  loadMembers(o.id);
  if (o.role === "owner") loadInvites(o.id);
  else invites.value = [];
});

async function changeRole(m: Member, role: string) {
  if (!org.value) return;
  try {
    await apiClient(`/api/orgs/${org.value.id}/members/${m.user_id}`, { method: "PATCH", body: { role } });
    loadMembers(org.value.id);
  } catch (e: any) {
    msg.value = e?.message || "改角色失败";
  }
}

async function removeMember(m: Member) {
  if (!org.value || m.role === "owner") return;
  try {
    await apiClient(`/api/orgs/${org.value.id}/members/${m.user_id}`, { method: "DELETE" });
    loadMembers(org.value.id);
  } catch (e: any) {
    msg.value = e?.message || "移除失败";
  }
}

async function createInvite() {
  if (!org.value) return;
  try {
    await apiPost(`/api/orgs/${org.value.id}/invites`, { expiresInDays: 7 });
    loadInvites(org.value.id);
  } catch (e: any) {
    msg.value = e?.message || "生成失败";
  }
}

async function revokeInvite(token: string) {
  if (!org.value) return;
  try {
    await apiClient(`/api/orgs/${org.value.id}/invites/${token}`, { method: "DELETE" });
    loadInvites(org.value.id);
  } catch (e: any) {
    msg.value = e?.message || "吊销失败";
  }
}

function inviteUrl(token: string) {
  return `${window.location.origin}/register?invite=${token}`;
}

async function copyInvite(token: string) {
  try {
    await navigator.clipboard.writeText(inviteUrl(token));
    copied.value = token;
    setTimeout(() => {
      copied.value = "";
    }, 2000);
  } catch {
    msg.value = "复制失败";
  }
}

function roleLabel(r: string) {
  return r === "owner" ? "所有者" : r === "admin" ? "管理员" : "成员";
}

const activeInvites = computed(() => invites.value.filter((i) => !i.revoked_at));

function selectOrg(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  org.value = orgs.value.find((o) => o.id === id) || null;
}
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
    <PageHeader title="成员管理" back-to="/admin" :breadcrumb="[{ label: '管理后台', to: '/admin' }, { label: '成员管理' }]" />

    <div class="flex items-center justify-end">
      <select
        v-if="orgs.length > 1"
        :value="org?.id || ''"
        @change="selectOrg"
        class="rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
      >
        <option v-for="o in orgs" :key="o.id" :value="o.id">{{ o.name }}{{ o.personal ? "（个人）" : "" }}</option>
      </select>
    </div>

    <p v-if="msg" class="text-sm text-red-500">{{ msg }}</p>

    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <Card padding="none" class="divide-y divide-gray-200 lg:col-span-2 dark:divide-gray-700">
        <div v-for="m in members" :key="m.user_id" class="flex items-center gap-3 p-3">
          <Avatar :name="m.display_name || m.handle" size="md" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-gray-900 dark:text-white">{{ m.display_name || m.handle }}</p>
            <p class="text-xs text-gray-500">@{{ m.handle }}</p>
          </div>
          <select
            v-if="isOwner && m.role !== 'owner'"
            :value="m.role"
            @change="changeRole(m, ($event.target as HTMLSelectElement).value)"
            class="rounded border border-gray-300 bg-gray-200 p-1.5 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
          >
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <span v-else class="text-xs text-gray-500">{{ roleLabel(m.role) }}</span>
          <Button
            v-if="isOwner && m.role !== 'owner'"
            variant="ghost"
            size="sm"
            class="text-red-500 hover:text-red-600"
            title="移除"
            @click="removeMember(m)"
          >✕</Button>
        </div>
        <p v-if="members.length === 0" class="p-4 text-sm text-gray-500">暂无成员</p>
      </Card>

      <Card v-if="isOwner" class="space-y-3 lg:col-span-1">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-semibold text-gray-900 dark:text-white">邀请同事加入</h3>
            <p class="mt-0.5 text-xs text-gray-500">生成链接发给同事，他们用链接注册后自动加入「{{ org?.name }}」。</p>
          </div>
          <Button size="sm" @click="createInvite">生成邀请链接</Button>
        </div>
        <div v-for="inv in activeInvites" :key="inv.token" class="flex items-center gap-2 rounded bg-gray-100 p-2 dark:bg-gray-900">
          <code class="flex-1 truncate text-xs text-gray-600 dark:text-gray-300">{{ inviteUrl(inv.token) }}</code>
          <span class="shrink-0 text-xs text-gray-400">
            已用 {{ inv.uses }}{{ inv.max_uses != null ? "/" + inv.max_uses : "" }} 次<template v-if="inv.expires_at"> · {{ new Date(inv.expires_at).toLocaleDateString() }} 过期</template>
          </span>
          <Button variant="ghost" size="sm" class="shrink-0" @click="copyInvite(inv.token)">{{ copied === inv.token ? "已复制 ✓" : "复制" }}</Button>
          <Button variant="ghost" size="sm" class="shrink-0 text-red-500 hover:text-red-600" title="吊销" @click="revokeInvite(inv.token)">✕</Button>
        </div>
        <p v-if="activeInvites.length === 0" class="text-xs text-gray-500">还没有有效的邀请链接。</p>
      </Card>
    </div>
  </div>
</template>
