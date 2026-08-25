<script setup lang="ts">
import { type AgentPresence, composePresence, PRESENCE_LABEL } from "@collabagent/shared";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet } from "../api";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import SidebarSection from "../components/layout/SidebarSection.vue";
import MemberProfileBody from "../components/people/MemberProfileBody.vue";
import Avatar from "../components/ui/Avatar.vue";
import Input from "../components/ui/Input.vue";
import { LG_QUERY, useMediaQuery } from "../composables";
import { runtimeCatalog, useAgentStore, useAuthStore, useUiStore } from "../stores";

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
  computer?: AgentComputer | null;
}

interface Human {
  handle: string;
  display_name?: string;
  avatar_url?: string;
}

const route = useRoute();
const router = useRouter();
const uiStore = useUiStore();
const agentStore = useAgentStore();
const authStore = useAuthStore();
const isDesktop = useMediaQuery(LG_QUERY);

const agents = ref<Agent[]>([]);
const humans = ref<Human[]>([]);
const loaded = ref(false);
const query = ref("");
const manageOpen = ref(false);

function openFromQuery() {
  const m = typeof route.query.member === "string" ? route.query.member.trim() : "";
  if (m) uiStore.openProfile({ handle: m.replace(/^@/, "") });
}

onMounted(async () => {
  try {
    const a = await apiGet<{ agents: Agent[] }>("/api/agents");
    agents.value = a.agents || [];
  } catch {
    /* ignore */
  }
  try {
    const s = await apiGet<{ humans?: Human[] }>("/api/server/info");
    humans.value = (s.humans || []).filter((h) => h.handle !== authStore.user?.handle);
  } catch {
    /* ignore */
  }
  loaded.value = true;
  openFromQuery();
});

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
const filteredHumans = computed(() => humans.value.filter((h) => matchesQuery(h.display_name || h.handle, h.handle)));

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

const empty = computed(() => loaded.value && agents.value.length === 0 && humans.value.length === 0);
const filterEmpty = computed(
  () => loaded.value && !empty.value && filteredAgents.value.length === 0 && filteredHumans.value.length === 0,
);

const selectedHandle = computed(() => uiStore.profileTarget?.handle || "");

function openPerson(handle: string) {
  uiStore.openProfile({ handle });
}

function onAgentDeleted(handle: string) {
  agents.value = agents.value.filter((a) => a.name !== handle && a.id !== handle);
}

function go(path: string) {
  manageOpen.value = false;
  void router.push(path);
}

const footerLabel = computed(() => `${humans.value.length} 位成员 · ${agents.value.length} 个 Agent`);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader title="成员" subtitle="工作区里的人与 Agent">
      <div class="relative">
        <button
          type="button"
          class="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          @click="manageOpen = !manageOpen"
        >
          管理
        </button>
        <button
          v-if="manageOpen"
          type="button"
          class="fixed inset-0 z-10 cursor-default"
          aria-label="关闭管理菜单"
          @click="manageOpen = false"
        />
        <div
          v-if="manageOpen"
          class="absolute right-0 z-20 mt-1 w-40 rounded-md border border-gray-200 bg-white py-1 shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="go('/admin/members')"
          >
            工作区成员
          </button>
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="go('/computers')"
          >
            我的计算机
          </button>
        </div>
      </div>
    </PageHeader>

    <div class="flex min-h-0 flex-1">
      <div
        class="flex min-h-0 w-full flex-col border-gray-200 dark:border-gray-700 lg:w-80 lg:shrink-0 lg:border-r"
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
          <p v-if="!loaded" class="py-8 text-center text-sm text-gray-400">加载中…</p>
          <EmptyState
            v-else-if="empty"
            icon="👥"
            title="还没有成员"
            description="连接计算机创建 Agent，或邀请同事后，会显示在这里"
          />
          <p v-else-if="filterEmpty" class="px-2 py-6 text-center text-sm text-gray-400">没有匹配的成员</p>

          <template v-else>
            <div class="mb-3">
              <div class="mb-1 flex items-center justify-between px-2">
                <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Agent</span>
                <span class="text-[10px] tabular-nums text-gray-400">{{ filteredAgents.length }}</span>
              </div>
              <p v-if="filteredAgents.length === 0" class="mb-1 px-2 text-xs text-gray-400">没有匹配的 Agent</p>
              <SidebarSection
                v-for="g in agentComputerGroups"
                :key="g.key"
                :title="g.title"
                :persist-key="'people.page.computer.' + g.key"
                :count="g.agents.length"
                class-name="mb-2"
              >
                <p class="mb-1 px-2 text-[10px] text-gray-400">
                  <span :class="g.online ? 'text-green-500' : 'text-gray-400'">{{ g.online ? "在线" : "离线" }}</span>
                  · {{ g.subtitle }}
                </p>
                <button
                  v-for="a in g.agents"
                  :key="a.id"
                  type="button"
                  :class="[
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
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
                    <p class="truncate font-mono text-[11px] text-gray-400">@{{ a.name }}</p>
                    <p v-if="a.description" class="truncate text-[11px] text-gray-500">{{ a.description }}</p>
                    <p class="truncate text-[11px] text-gray-400">{{ runtimeLine(a) }}</p>
                  </div>
                </button>
              </SidebarSection>
            </div>

            <SidebarSection title="成员" persist-key="people.page.humans" :count="filteredHumans.length">
              <p v-if="filteredHumans.length === 0" class="px-2 text-xs text-gray-400">没有匹配的成员</p>
              <button
                v-for="h in filteredHumans"
                :key="h.handle"
                type="button"
                :class="[
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  selectedHandle === h.handle
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                    : 'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-700',
                ]"
                @click="openPerson(h.handle)"
              >
                <Avatar :name="h.display_name || h.handle" :src="h.avatar_url" size="sm" />
                <div class="min-w-0 flex-1">
                  <p class="truncate">{{ h.display_name || h.handle }}</p>
                  <p class="truncate text-[11px] text-gray-400">@{{ h.handle }}</p>
                </div>
              </button>
            </SidebarSection>
          </template>
        </div>

        <p
          v-if="loaded && !empty"
          class="border-t border-gray-200 px-3 py-2 text-[11px] text-gray-400 dark:border-gray-700"
        >
          {{ footerLabel }}
        </p>
      </div>

      <div v-if="isDesktop" class="hidden min-h-0 min-w-0 flex-1 overflow-hidden p-6 lg:flex lg:flex-col">
        <MemberProfileBody v-if="selectedHandle" :handle="selectedHandle" embedded @deleted="onAgentDeleted" />
        <div v-else class="flex h-full flex-col items-center justify-center text-center">
          <p class="text-sm text-gray-500 dark:text-gray-400">选一个成员看档案</p>
          <p class="mt-1 text-xs text-gray-400">单击左侧名单即可</p>
        </div>
      </div>
    </div>
  </div>
</template>
