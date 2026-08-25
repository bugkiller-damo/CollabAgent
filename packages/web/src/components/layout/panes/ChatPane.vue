<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet } from "../../../api";
import { useAuthStore, useChannelStore, useUiStore } from "../../../stores";
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
  lastContent?: string;
}

interface PeopleItem {
  handle: string;
  displayName: string;
  type: "human" | "agent";
}

const channelStore = useChannelStore();
const authStore = useAuthStore();
const uiStore = useUiStore();
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
    .then((d) => {
      dms.value = d.dms || [];
    })
    .catch(() => {});
}

watch(
  () => route.path,
  () => loadDms(),
  { immediate: true },
);

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
  uiStore.closeMobileDrawer();
  router.push("/dm/" + handle);
}

function isPriv(c: any): boolean {
  return c.type === "private" || c.visibility === "private";
}

const publicChannels = computed(() => channels.value.filter((c: any) => !isPriv(c)));
const privateChannels = computed(() => channels.value.filter((c: any) => isPriv(c)));

function onSelectChannel(ch: any) {
  channelStore.setActiveChannel(ch.name);
  uiStore.closeMobileDrawer();
  router.push("/channels/" + ch.name);
}

function onCreated(name: string) {
  channelStore.setActiveChannel(name);
  uiStore.closeMobileDrawer();
  router.push("/channels/" + name);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <nav class="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
      <SidebarSection title="频道" persist-key="chat.public" :count="publicChannels.length">
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
          <span v-if="(unreadCounts[ch.name] || 0) > 0" class="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-xs text-white">
            {{ unreadCounts[ch.name] }}
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
          @click="startDm(d.peerHandle)"
        >
          <Avatar :name="d.peerName || d.peerHandle" size="sm" />
          <span class="truncate">{{ d.peerName || d.peerHandle }}</span>
        </button>
        <p v-if="dms.length === 0" class="px-2 py-1 text-xs text-gray-400">点 + 发起私信</p>
      </SidebarSection>
    </nav>

    <AgentStatusBar />
    <CreateChannelModal v-if="showCreateChannel" :on-close="() => (showCreateChannel = false)" :on-created="onCreated" />
  </div>
</template>
