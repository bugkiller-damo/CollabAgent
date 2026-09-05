<script setup lang="ts">
import { type AgentPresence, composePresence, PRESENCE_LABEL } from "@collabagent/shared";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiGet } from "../../api";
import { useAgentStore, useChannelStore, useUiStore } from "../../stores";
import Avatar from "../ui/Avatar.vue";

interface Agent {
  id: string;
  name: string;
  display_name: string;
  isOnline: boolean;
  duty?: "on" | "off";
  presence?: AgentPresence;
  avatar_url?: string;
}

const LIVE_STATUS_LABEL = PRESENCE_LABEL;

const route = useRoute();
const uiStore = useUiStore();
const agentStore = useAgentStore();
const channelStore = useChannelStore();

const allAgents = ref<Agent[]>([]);
const loaded = ref(false);

onMounted(() => {
  apiGet<{ agents: Agent[] }>("/api/agents")
    .then((d) => {
      allAgents.value = d.agents || [];
      loaded.value = true;
    })
    .catch(() => {
      loaded.value = true;
    });
});

const currentChannel = computed(() => channelStore.channels.find((c) => c.name === channelStore.activeChannelName));

watch(
  () => currentChannel.value?.id,
  (id) => {
    if (id) void channelStore.fetchMembers(id);
  },
  { immediate: true },
);

const dmPeer = computed(() => {
  if (!route.path.startsWith("/dm/")) return "";
  try {
    return decodeURIComponent(route.path.split("/")[2] || "");
  } catch {
    return route.path.split("/")[2] || "";
  }
});

const agents = computed(() => {
  const ch = currentChannel.value;
  if (ch?.id) {
    const members = channelStore.membersByChannelId[ch.id];
    if (members) {
      const names = new Set(members.filter((m) => m.member_type === "agent").map((m) => m.handle));
      return allAgents.value.filter((a) => names.has(a.name));
    }
    return [];
  }
  if (dmPeer.value) return allAgents.value.filter((a) => a.name === dmPeer.value);
  return [];
});

const liveAgents = computed(() => agentStore.agents);
const terminalAgent = computed(() => uiStore.terminalAgent);

function statusFor(a: Agent): { text: string; cls: string; dot: string } {
  const live = liveAgents.value[a.name];
  const presence = live?.presence || a.presence || composePresence(a.duty ?? "on", !!a.isOnline, live?.status);
  return LIVE_STATUS_LABEL[presence] || LIVE_STATUS_LABEL.computer_offline;
}

function openTerminal(name: string) {
  uiStore.openTerminal(terminalAgent.value === name ? null : name);
}
</script>

<template>
  <div v-if="loaded" class="border-t border-gray-200 p-2 dark:border-gray-700">
    <div class="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted">
      Agent 状态
    </div>
    <div v-if="agents.length === 0" class="px-2 py-1.5 text-xs text-muted">
      {{ currentChannel || dmPeer ? "本频道还没有 Agent 成员" : "打开一个频道查看 Agent" }}
    </div>
    <template v-else>
      <button
        v-for="a in agents"
        :key="a.id"
        :title="'观察终端'"
        :class="[
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
          terminalAgent === a.name
            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
            : 'hover:bg-raised',
        ]"
        @click="openTerminal(a.name)"
      >
        <div :class="['h-2 w-2 shrink-0 rounded-full', statusFor(a).dot]" />
        <Avatar :name="a.display_name || a.name" :src="a.avatar_url" size="sm" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1">
            <span class="truncate text-gray-600 dark:text-gray-300">@{{ a.name }}</span>
            <span :class="['ml-auto shrink-0 text-[10px]', statusFor(a).cls]">{{ statusFor(a).text }}</span>
          </div>
          <p
            v-if="liveAgents[a.name]?.detail"
            class="truncate text-[10px] text-muted"
            :title="liveAgents[a.name].detail"
          >
            {{ liveAgents[a.name].detail }}
          </p>
        </div>
      </button>
    </template>
  </div>
</template>
