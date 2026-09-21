<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { apiClient, apiGet } from "../../api";
import Avatar from "../ui/Avatar.vue";
import Button from "../ui/Button.vue";

interface InviteCandidate {
  member_id: string;
  member_type: "human" | "agent";
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

const props = defineProps<{ channelId: string }>();
const emit = defineEmits<{ invited: [] }>();

const query = ref("");
const candidates = ref<InviteCandidate[]>([]);
const loaded = ref(false);
const open = ref(false);
const selectedIdx = ref(0);
const busy = ref(false);
const msg = ref("");
const msgOk = ref(false);
const rootRef = ref<HTMLDivElement | null>(null);

async function loadCandidates() {
  try {
    const data = await apiGet<{ candidates: InviteCandidate[] }>(`/api/channels/${props.channelId}/invitable`);
    candidates.value = data.candidates || [];
  } catch {
    candidates.value = [];
  }
  loaded.value = true;
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return candidates.value;
  return candidates.value.filter(
    (c) => c.handle.toLowerCase().includes(q) || (c.display_name || "").toLowerCase().includes(q),
  );
});

const showList = computed(() => open.value && loaded.value);
const highlight = computed(() =>
  selectedIdx.value >= 0 && selectedIdx.value < filtered.value.length ? filtered.value[selectedIdx.value] : undefined,
);

// 候选被邀请移除 / 输入收窄过滤后，高亮下标钳回界内（上下界都钳）——否则会出现
// 「无高亮行但 Enter 仍选中末位」或 selectedIdx=-1 的错位
watch(filtered, () => {
  selectedIdx.value = Math.min(Math.max(selectedIdx.value, 0), Math.max(0, filtered.value.length - 1));
});

function onFocus() {
  open.value = true;
  selectedIdx.value = 0;
  if (!loaded.value) void loadCandidates();
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  open.value = true;
  selectedIdx.value = 0;
}

function onDocDown(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t && rootRef.value?.contains(t)) return;
  open.value = false;
}

onMounted(() => document.addEventListener("mousedown", onDocDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocDown));

watch(
  () => props.channelId,
  () => {
    query.value = "";
    candidates.value = [];
    loaded.value = false;
    msg.value = "";
    if (open.value) void loadCandidates();
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (filtered.value.length > 0) {
      selectedIdx.value = Math.min(selectedIdx.value + 1, filtered.value.length - 1);
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (filtered.value.length > 0) {
      selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
    }
  } else if (e.key === "Enter") {
    if (showList.value && highlight.value) invite(highlight.value);
    else invite();
  } else if (e.key === "Escape") {
    open.value = false;
  }
}

async function invite(c?: InviteCandidate) {
  const handle = (c?.handle ?? query.value).trim().replace(/^@/, "");
  if (!handle || busy.value) return;
  busy.value = true;
  msg.value = "";
  try {
    // 点选候选时带精确目标（memberId+memberType）——同名 human/agent 共存时
    // handle 无法消歧；手输 handle 无候选可附，走服务端 legacy 解析
    await apiClient(`/api/channels/${props.channelId}/invite`, {
      method: "POST",
      body: c ? { handle, memberId: c.member_id, memberType: c.member_type } : { handle },
    });
    if (c) {
      // 只移除精确目标：同名 human/agent 候选可能共存，按 handle 过滤会误删同名项
      candidates.value = candidates.value.filter(
        (x) => !(x.member_id === c.member_id && x.member_type === c.member_type),
      );
    } else {
      // 手输 handle：服务端解析结果本地无从对应，重新拉权威候选列表
      await loadCandidates();
    }
    query.value = "";
    selectedIdx.value = 0;
    msg.value = `已邀请 @${handle}`;
    msgOk.value = true;
    emit("invited");
  } catch (err: any) {
    msgOk.value = false;
    msg.value =
      err?.message === "user or agent not found"
        ? "用户/Agent 不存在"
        : err?.message === "already a member"
          ? "已是成员"
          : err?.message === "user is not a member of that server"
            ? "该用户不在本服务器，请先邀请其加入服务器"
            : err?.message === "only channel admins can invite members"
              ? "仅频道管理员可邀请"
              : err?.message || "邀请失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div ref="rootRef" class="relative space-y-1">
    <div class="flex gap-1">
      <input
        type="text"
        :value="query"
        @input="onInput"
        @focus="onFocus"
        @keydown="onKeydown"
        placeholder="搜索成员 / Agent，或输入 handle 邀请"
        class="flex-1 min-w-0 text-sm p-1.5 rounded-md bg-white dark:bg-gray-700 text-ink border border-gray-300 dark:border-gray-600"
      />
      <Button size="sm" :disabled="busy || !query.trim()" @click="invite()">邀请</Button>
    </div>

    <div
      v-if="showList"
      class="absolute left-0 right-0 z-20 mt-0.5 max-h-56 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800"
    >
      <button
        v-for="(c, i) in filtered"
        :key="c.member_type + ':' + c.member_id"
        type="button"
        @mousedown.prevent="invite(c)"
        @mouseenter="selectedIdx = i"
        class="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        :class="i === selectedIdx ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-gray-100 dark:hover:bg-gray-700'"
      >
        <Avatar :name="c.display_name || c.handle" :src="c.avatar_url || undefined" size="sm" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm text-gray-800 dark:text-gray-200">{{ c.display_name || c.handle }}</div>
          <div class="truncate text-xs text-muted">@{{ c.handle }}</div>
        </div>
        <span
          class="shrink-0 rounded px-1 py-0.5 text-[10px]"
          :class="
            c.member_type === 'agent'
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
          "
        >
          {{ c.member_type === "agent" ? "Agent" : "成员" }}
        </span>
      </button>
      <p v-if="filtered.length === 0" class="px-2 py-3 text-center text-xs text-muted">
        {{ query.trim() ? "没有匹配的候选" : "可邀请的成员都已加入" }}
      </p>
    </div>

    <p v-if="msg" :class="'text-xs ' + (msgOk ? 'text-green-500' : 'text-red-400')">{{ msg }}</p>
  </div>
</template>
