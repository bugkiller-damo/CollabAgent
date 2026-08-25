import type { AgentDuty, AgentPresence } from "@collabagent/shared";
import { composePresence } from "@collabagent/shared";
import { defineStore } from "pinia";
import { ref } from "vue";

export type AgentActivity = "online" | "offline" | "thinking" | "working" | "idle" | "starting" | "stopped";

interface AgentInfo {
  id: string;
  name: string;
  status: AgentActivity;
  detail: string;
  lastSeen: string;
  duty?: AgentDuty;
  computerOnline?: boolean;
  presence?: AgentPresence;
}

export const useAgentStore = defineStore("agents", () => {
  const agents = ref<Record<string, AgentInfo>>({});

  function updateStatus(id: string, status: AgentActivity, detail = ""): void {
    const prev = agents.value[id];
    const duty = prev?.duty ?? "on";
    const computerOnline = prev?.computerOnline ?? true;
    agents.value = {
      ...agents.value,
      [id]: {
        ...(prev || {
          id,
          name: id.slice(0, 8),
          status: "idle" as AgentActivity,
          detail: "",
          lastSeen: "",
        }),
        status,
        detail,
        lastSeen: new Date().toISOString(),
        duty,
        computerOnline,
        presence: composePresence(duty, computerOnline, status),
      },
    };
  }

  function applyPresence(payload: {
    agentName: string;
    agentId?: string;
    duty: AgentDuty;
    computerOnline: boolean;
    presence: AgentPresence;
  }): void {
    const id = payload.agentName;
    const prev = agents.value[id];
    agents.value = {
      ...agents.value,
      [id]: {
        ...(prev || {
          id: payload.agentId || id,
          name: id,
          status: "idle" as AgentActivity,
          detail: "",
          lastSeen: "",
        }),
        duty: payload.duty,
        computerOnline: payload.computerOnline,
        presence: payload.presence,
        lastSeen: new Date().toISOString(),
      },
    };
  }

  function setAgents(list: AgentInfo[]): void {
    const map: Record<string, AgentInfo> = {};
    list.forEach((a) => {
      map[a.id] = a;
    });
    agents.value = map;
  }

  /** T4：频道顶栏「正在做什么」（不落库，agent:progress WS） */
  const progressByChannel = ref<Record<string, { agentName: string; headline: string }>>({});
  const progressByAgent = ref<Record<string, { channelName: string; headline: string }>>({});

  function setProgress(channelName: string, agentName: string, headline: string): void {
    const key = channelName.replace(/^#/, "");
    progressByChannel.value = { ...progressByChannel.value, [key]: { agentName, headline } };
    progressByAgent.value = { ...progressByAgent.value, [agentName]: { channelName: key, headline } };
  }

  function clearProgress(channelName: string, agentName?: string): void {
    const key = channelName.replace(/^#/, "");
    const nextCh = { ...progressByChannel.value };
    const cur = nextCh[key];
    if (!agentName || !cur || cur.agentName === agentName) delete nextCh[key];
    progressByChannel.value = nextCh;
    if (agentName) {
      const nextAg = { ...progressByAgent.value };
      delete nextAg[agentName];
      progressByAgent.value = nextAg;
    }
  }

  return {
    agents,
    updateStatus,
    applyPresence,
    setAgents,
    progressByChannel,
    progressByAgent,
    setProgress,
    clearProgress,
  };
});
