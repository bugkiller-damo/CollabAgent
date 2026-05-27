import { create } from "zustand";
import { apiGet, apiPost } from "../api/client";
import type { Channel } from "@collabagent/shared";

interface ChannelState {
  channels: Channel[];
  joinedChannels: Set<string>;
  activeChannelName: string | null;
  unreadCounts: Record<string, number>;
  fetchChannels: () => Promise<void>;
  joinChannel: (name: string) => Promise<void>;
  leaveChannel: (name: string) => Promise<void>;
  setActiveChannel: (name: string) => void;
  incrementUnread: (channelName: string) => void;
  clearUnread: (channelName: string) => void;
}

export const useChannelStore = create<ChannelState>((set, get) => ({
  channels: [],
  joinedChannels: new Set(),
  activeChannelName: null,
  unreadCounts: {},

  fetchChannels: async () => {
    try {
      const data = await apiGet<{ channels: Channel[] }>("/api/server/info");
      const chs = data.channels || [];
      set({
        channels: chs,
        joinedChannels: new Set(chs.filter((c) => c.joined).map((c) => c.name)),
      });
    } catch {
      // backend not ready
    }
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
