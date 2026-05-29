import { create } from "zustand";

export type AgentActivity = "online" | "offline" | "thinking" | "working" | "idle";

interface AgentInfo {
  id: string;
  name: string;
  status: AgentActivity;
  detail: string;
  lastSeen: string;
}

interface AgentState {
  agents: Record<string, AgentInfo>;
  updateStatus: (id: string, status: AgentActivity, detail?: string) => void;
  setAgents: (list: AgentInfo[]) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: {},

  updateStatus: (id, status, detail = "") => {
    set((s) => ({
      agents: {
        ...s.agents,
        [id]: { ...s.agents[id] || { id, name: id.slice(0, 8), status: "idle", detail: "", lastSeen: "" }, status, detail, lastSeen: new Date().toISOString() },
      },
    }));
  },

  setAgents: (list) => {
    const map: Record<string, AgentInfo> = {};
    list.forEach((a) => { map[a.id] = a; });
    set({ agents: map });
  },
}));
