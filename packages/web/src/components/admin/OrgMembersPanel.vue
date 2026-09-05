<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiClient, apiGet } from "../../api";
import { toast } from "../../stores/toastStore";
import Button from "../ui/Button.vue";

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

// 管理「我的私有空间」的协作成员：被加进来的人能看到我创建的 Agent。
const org = ref<Org | null>(null);
const members = ref<Member[]>([]);
const invite = ref("");
const msg = ref("");
const busy = ref(false);

function loadMembers(orgId: string) {
  apiGet<{ members: Member[] }>(`/api/orgs/${orgId}/members`)
    .then((d) => {
      members.value = d.members || [];
    })
    .catch(() => {});
}

async function loadOrg() {
  try {
    const d = await apiGet<{ orgs: Org[] }>("/api/orgs");
    const personal = (d.orgs || []).find((o) => o.personal) || null;
    org.value = personal;
    if (personal) loadMembers(personal.id);
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  loadOrg();
});

async function doInvite() {
  const h = invite.value.trim();
  if (!h || !org.value) return;
  busy.value = true;
  msg.value = "";
  try {
    await apiClient(`/api/orgs/${org.value.id}/members`, { method: "POST", body: { handle: h } });
    invite.value = "";
    msg.value = "已加入";
    loadMembers(org.value.id);
  } catch (err: any) {
    msg.value = err?.message === "user not found" ? "用户不存在" : err?.message || "邀请失败";
  } finally {
    busy.value = false;
  }
}

async function removeMember(m: Member) {
  if (!org.value || m.role === "owner") return;
  try {
    await apiClient(`/api/orgs/${org.value.id}/members/${m.user_id}`, { method: "DELETE" });
    loadMembers(org.value.id);
  } catch (err: any) {
    toast.error(err?.message || "移除失败");
  }
}

function onInviteKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") doInvite();
}
</script>

<template>
  <div v-if="org" class="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 space-y-3">
    <div>
      <h3 class="text-ink font-semibold">协作空间「{{ org.name }}」</h3>
      <p class="text-gray-500 text-xs mt-0.5">加入这里的成员能看到你在此空间创建的 Agent（共 {{ org.agentCount }} 个）。新建 Agent 默认进入这里、仅你可见。</p>
    </div>
    <div class="flex gap-2">
      <input
        :value="invite"
        @input="invite = ($event.target as HTMLInputElement).value"
        @keydown="onInviteKeydown"
        placeholder="输入用户名邀请协作者"
        class="flex-1 p-2 rounded-md text-sm bg-raised text-ink border border-gray-300 dark:border-gray-600"
      />
      <Button
        size="sm"
        :disabled="busy || !invite.trim()"
        @click="doInvite"
      >邀请</Button>
    </div>
    <p v-if="msg" :class="'text-xs ' + (msg === '已加入' ? 'text-green-500' : 'text-red-400')">{{ msg }}</p>
    <div class="flex flex-wrap gap-2">
      <span
        v-for="m in members"
        :key="m.user_id"
        class="group inline-flex items-center gap-1.5 text-sm bg-raised rounded-full pl-2.5 pr-1.5 py-1 text-gray-700 dark:text-gray-200"
      >
        @{{ m.handle }}<span v-if="m.role === 'owner'" class="text-[10px] text-blue-500">(你)</span>
        <button
          v-if="m.role !== 'owner'"
          @click="removeMember(m)"
          title="移除"
          class="text-muted hover:text-red-500 opacity-0 group-hover:opacity-100"
        >✕</button>
      </span>
    </div>
  </div>
</template>
