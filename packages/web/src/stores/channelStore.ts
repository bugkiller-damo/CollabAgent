import { create } from "zustand";
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
    const res = await fetch("/api/server/info");
    const data = await res.json();
    set({
      channels: data.channels,
      joinedChannels: new Set(data.channels.filter((c: Channel) => c.joined).map((c: Channel) => c.name)),
    });
  },

  joinChannel: async (name) => {
    await fetch(`/api/channels/${name}/join`, { method: "POST" });
    set((s) => {
      const next = new Set(s.joinedChannels);
      next.add(name);
      return { joinedChannels: next };
    });
  },

  leaveChannel: async (name) => {
    await fetch(`/api/channels/${name}/leave`, { method: "POST" });
    set((s) => {
      const next = new Set(s.joinedChannels);
      next.delete(name);
      return { joinedChannels: next };
    });
  },

  setActiveChannel: (name) => {
    set({ activeChannelName: name });
    get().clearUnread(name);
  },

  incrementUnread: (name) => {
    set((s) => ({
      unreadCounts: { ...s.unreadCounts, [name]: (s.unreadCounts[name] || 0) + 1 },
    }));
  },

  clearUnread: (name) => {
    set((s) => ({
      unreadCounts: { ...s.unreadCounts, [name]: 0 },
    }));
  },
}));
