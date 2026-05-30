import { create } from "zustand";
import { apiGet, apiPost, apiPatch } from "../api/client";
import type { Channel } from "@collabagent/shared";

interface ChannelState {
  channels: Channel[];
  serverId: string | null;
  joinedChannels: Set<string>;
  activeChannelName: string | null;
  unreadCounts: Record<string, number>;
  fetchChannels: () => Promise<void>;
  createChannel: (input: { name: string; description?: string; type?: "public" | "private" }) => Promise<Channel>;
  updateChannel: (channelId: string, patch: { description?: string; type?: "public" | "private"; archived?: boolean }) => Promise<void>;
  joinChannel: (name: string) => Promise<void>;
  leaveChannel: (name: string) => Promise<void>;
  setActiveChannel: (name: string) => void;
  incrementUnread: (channelName: string) => void;
  clearUnread: (channelName: string) => void;
}

export const useChannelStore = create<ChannelState>((set, get) => ({
  channels: [],
  serverId: null,
  joinedChannels: new Set(),
  activeChannelName: null,
  unreadCounts: {},

  fetchChannels: async () => {
    try {
      const data = await apiGet<{ channels: Channel[]; serverId?: string }>("/api/server/info");
      const chs = data.channels || [];
      set({
        channels: chs,
        serverId: data.serverId || get().serverId,
        joinedChannels: new Set(chs.filter((c) => c.joined).map((c) => c.name)),
      });
    } catch {
      // backend not ready
    }
  },

  createChannel: async ({ name, description, type }) => {
    const data = await apiPost<{ channel: Channel }>("/api/channels", {
      serverId: get().serverId,
      name,
      description,
      type: type || "public",
    });
    await get().fetchChannels();
    return data.channel;
  },

  updateChannel: async (channelId, patch) => {
    await apiPatch(`/api/channels/${channelId}`, patch);
    await get().fetchChannels();
  },

  joinChannel: async (name) => {
    await apiPost(`/api/channels/${name}/join`);
    set((s) => { const next = new Set(s.joinedChannels); next.add(name); return { joinedChannels: next }; });
  },

  leaveChannel: async (name) => {
    await apiPost(`/api/channels/${name}/leave`);
    set((s) => { const next = new Set(s.joinedChannels); next.delete(name); return { joinedChannels: next }; });
  },

  setActiveChannel: (name) => { set({ activeChannelName: name }); get().clearUnread(name); },
  incrementUnread: (name) => set((s) => ({ unreadCounts: { ...s.unreadCounts, [name]: (s.unreadCounts[name] || 0) + 1 } })),
  clearUnread: (name) => set((s) => ({ unreadCounts: { ...s.unreadCounts, [name]: 0 } })),
}));
