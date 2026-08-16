<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useChannelStore, useAuthStore } from "../../stores";
import { apiGet } from "../../api";
import AgentStatusBar from "./AgentStatusBar.vue";
import ConnectionStatus from "./ConnectionStatus.vue";
import UserProfileFooter from "./UserProfileFooter.vue";
import CreateChannelModal from "../channel/CreateChannelModal.vue";
import SidebarSection from "./SidebarSection.vue";
import NavItem from "../ui/NavItem.vue";
import IconButton from "../ui/IconButton.vue";
import Avatar from "../ui/Avatar.vue";

interface DmItem {
  channelId: string;
  peerHandle: string;
  peerName: string;
  peerType: "human" | "agent";
  lastContent?: string;
}

interface PeopleItem {
  handle: string;
  displayName: string;
  type: "human" | "agent";
}

const channelStore = useChannelStore();
const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();

const showCreateChannel = ref(false);
const showPeople = ref(false);
const people = ref<PeopleItem[]>([]);
const dms = ref<DmItem[]>([]);

const user = computed(() => authStore.user);
const activeDmHandle = computed(() =>
  route.path.startsWith("/dm/") ? decodeURIComponent(route.path.split("/")[2] || "") : "",
);

const channels = computed(() => channelStore.channels);
const activeChannelName = computed(() => channelStore.activeChannelName);
const unreadCounts = computed(() => channelStore.unreadCounts);

function loadDms() {
  apiGet<{ dms: DmItem[] }>("/api/channels/dms")
    .then((d) => { dms.value = d.dms || []; })
    .catch(() => {});
}

watch(() => route.path, () => loadDms(), { immediate: true });

async function openPeoplePicker() {
  showPeople.value = !showPeople.value;
  if (people.value.length > 0) return;
  const list: PeopleItem[] = [];
  try {
    const a = await apiGet<{ agents: any[] }>("/api/agents");
    for (const x of a.agents || []) {
      list.push({ handle: x.name, displayName: x.display_name || x.name, type: "agent" });
    }
  } catch {}
  try {
    const s = await apiGet<any>("/api/server/info");
    for (const h of s.humans || []) {
      if (h.handle === user.value?.handle) continue;
      list.push({ handle: h.handle, displayName: h.display_name || h.handle, type: "human" });
    }
  } catch {}
  people.value = list;
}

function startDm(handle: string) {
  showPeople.value = false;
  router.push("/dm/" + handle);
}

// 字段兼容：server 返回 type，shared 类型叫 visibility。
function isPriv(c: any): boolean {
  return c.type === "private" || c.visibility === "private";
}

const publicChannels = computed(() => channels.value.filter((c: any) => !isPriv(c)));
const privateChannels = computed(() => channels.value.filter((c: any) => isPriv(c)));

function onSelectChannel(ch: any) {
  channelStore.setActiveChannel(ch.name);
  router.push("/channels/" + ch.name);
}

function onCreated(name: string) {
  channelStore.setActiveChannel(name);
  router.push("/channels/" + name);
}
</script>

<template>
  <aside class="flex h-full w-60 shrink-0 flex-col border-r border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
    <div class="border-b border-gray-200 p-4 dark:border-gray-700">
      <button class="flex w-full items-center gap-2 text-left">
        <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
          <span class="text-sm font-bold">C</span>
        </div>
        <div class="min-w-0">
          <h1 class="truncate text-base font-bold text-gray-900 dark:text-white">CollabAgent</h1>
          <p class="truncate text-xs text-gray-500 dark:text-gray-400">{{ user?.handle ? `@${user.handle}` : "Workspace" }}</p>
        </div>
      </button>
    </div>

    <nav class="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
      <SidebarSection title="频道">
        <template #action>
          <IconButton label="创建频道" tooltip="创建频道" class="h-6 w-6" @click="showCreateChannel = true">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </IconButton>
        </template>
        <button
          v-for="ch in publicChannels"
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
            <span class="text-gray-400">#</span>
            <span class="truncate">{{ ch.name }}</span>
          </span>
          <span v-if="(unreadCounts[ch.name] || 0) > 0" class="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-xs text-white">
            {{ unreadCounts[ch.name] }}
          </span>
        </button>
      </SidebarSection>

      <SidebarSection v-if="privateChannels.length > 0" title="私有频道">
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
          <span v-if="(unreadCounts[ch.name] || 0) > 0" class="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-xs text-white">
            {{ unreadCounts[ch.name] }}
          </span>
        </button>
      </SidebarSection>

      <SidebarSection title="私信">
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
              <div v-if="people.length === 0" class="px-3 py-2 text-xs text-gray-400">没有可私信的对象</div>
              <button
                v-for="p in people"
                :key="p.type + ':' + p.handle"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                @click="startDm(p.handle)"
              >
                <Avatar :name="p.displayName" size="sm" />
                <span class="truncate">{{ p.displayName }}</span>
                <span class="ml-auto text-xs text-gray-400">@{{ p.handle }}</span>
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
          @click="router.push('/dm/' + d.peerHandle)"
        >
          <Avatar :name="d.peerName || d.peerHandle" size="sm" />
          <span class="truncate">{{ d.peerName || d.peerHandle }}</span>
        </button>
        <p v-if="dms.length === 0" class="px-2 py-1 text-xs text-gray-400">点 + 发起私信</p>
      </SidebarSection>

      <SidebarSection title="应用">
        <NavItem to="/tasks">
          <template #icon>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
            </svg>
          </template>
          任务看板
        </NavItem>
        <NavItem to="/connect">
          <template #icon>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
            </svg>
          </template>
          接入 Agent
        </NavItem>
      </SidebarSection>

      <SidebarSection title="系统">
        <NavItem to="/admin">
          <template #icon>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.27 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </template>
          管理后台
        </NavItem>
        <NavItem to="/connect">
          <template #icon>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
            </svg>
          </template>
          接入 Agent
        </NavItem>
      </SidebarSection>
    </nav>

    <AgentStatusBar />
    <div class="border-t border-gray-200 dark:border-gray-700">
      <ConnectionStatus />
    </div>
    <UserProfileFooter />

    <CreateChannelModal v-if="showCreateChannel" :on-close="() => (showCreateChannel = false)" :on-created="onCreated" />
  </aside>
</template>
