import { ref } from "vue";
import { defineStore } from "pinia";

export type AgentActivity = "online" | "offline" | "thinking" | "working" | "idle";

interface AgentInfo {
  id: string;
  name: string;
  status: AgentActivity;
  detail: string;
  lastSeen: string;
}

export const useAgentStore = defineStore("agents", () => {
  const agents = ref<Record<string, AgentInfo>>({});

  function updateStatus(id: string, status: AgentActivity, detail = ""): void {
    agents.value = {
      ...agents.value,
      [id]: { ...(agents.value[id] || { id, name: id.slice(0, 8), status: "idle" as AgentActivity, detail: "", lastSeen: "" }), status, detail, lastSeen: new Date().toISOString() },
    };
  }

  function setAgents(list: AgentInfo[]): void {
    const map: Record<string, AgentInfo> = {};
    list.forEach((a) => { map[a.id] = a; });
    agents.value = map;
  }

  return { agents, updateStatus, setAgents };
});
