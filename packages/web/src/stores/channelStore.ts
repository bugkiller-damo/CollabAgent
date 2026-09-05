import type { Channel } from "@collabagent/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { apiGet, apiPatch, apiPost } from "../api";
import { toast } from "./toastStore";

export interface ChannelMember {
  member_id: string;
  member_type: "human" | "agent";
  role?: string;
  is_manager?: boolean;
  handle: string;
  display_name?: string;
}

export const useChannelStore = defineStore("channels", () => {
  const channels = ref<Channel[]>([]);
  const serverId = ref<string | null>(null);
  const joinedChannels = ref<Set<string>>(new Set());
  const activeChannelName = ref<string | null>(null);
  const unreadCounts = ref<Record<string, number>>({});
  /** 当前频道的成员（观察面板/侧栏只展示已加入的 agent） */
  const membersByChannelId = ref<Record<string, ChannelMember[]>>({});

  async function fetchMembers(channelId: string): Promise<ChannelMember[]> {
    if (!channelId) return [];
    try {
      const data = await apiGet<{ members: ChannelMember[] }>(`/api/channels/${channelId}/members`);
      const members = data.members || [];
      membersByChannelId.value = { ...membersByChannelId.value, [channelId]: members };
      return members;
    } catch {
      return membersByChannelId.value[channelId] ?? [];
    }
  }

  async function fetchChannels(): Promise<void> {
    try {
      const data = await apiGet<{ channels: Channel[]; serverId?: string }>("/api/server/info");
      const chs = data.channels || [];
      channels.value = chs;
      serverId.value = data.serverId || serverId.value;
      joinedChannels.value = new Set(chs.filter((c) => c.joined).map((c) => c.name));
    } catch (err: any) {
      toast.error("加载频道列表失败：" + (err?.message || "网络错误"));
    }
  }

  async function createChannel(input: {
    name: string;
    description?: string;
    type?: "public" | "private";
  }): Promise<Channel> {
    const { name, description, type } = input;
    const data = await apiPost<{ channel: Channel }>("/api/channels", {
      serverId: serverId.value,
      name,
      description,
      type: type || "public",
    });
    await fetchChannels();
    return data.channel;
  }

  async function updateChannel(
    channelId: string,
    patch: { description?: string; type?: "public" | "private"; archived?: boolean; managerTriageEnabled?: boolean },
  ): Promise<void> {
    await apiPatch(`/api/channels/${channelId}`, patch);
    await fetchChannels();
  }

  async function joinChannel(name: string): Promise<void> {
    await apiPost(`/api/channels/${name}/join`);
    const next = new Set(joinedChannels.value);
    next.add(name);
    joinedChannels.value = next;
  }

  async function leaveChannel(name: string): Promise<void> {
    await apiPost(`/api/channels/${name}/leave`);
    const next = new Set(joinedChannels.value);
    next.delete(name);
    joinedChannels.value = next;
  }

  function setActiveChannel(name: string): void {
    activeChannelName.value = name;
    clearUnread(name);
  }

  // 未读计数 key 约定：频道 = 裸名（无 #），与 ChatPane 读侧（unreadCounts[ch.name]）及
  // activeChannelName 同口径。写/清两侧入口统一去 # 归一化（P1-9 教训：wsDispatch 曾写
  // "#name" 而读/清用裸名，徽标永不亮、清除不落同 key——单点收敛防口径漂移）
  function unreadKey(name: string): string {
    return name.startsWith("#") ? name.slice(1) : name;
  }

  function incrementUnread(channelName: string): void {
    const key = unreadKey(channelName);
    unreadCounts.value = { ...unreadCounts.value, [key]: (unreadCounts.value[key] || 0) + 1 };
  }

  function clearUnread(channelName: string): void {
    unreadCounts.value = { ...unreadCounts.value, [unreadKey(channelName)]: 0 };
  }

  return {
    channels,
    serverId,
    joinedChannels,
    activeChannelName,
    unreadCounts,
    fetchChannels,
    createChannel,
    updateChannel,
    joinChannel,
    leaveChannel,
    setActiveChannel,
    incrementUnread,
    clearUnread,
    membersByChannelId,
    fetchMembers,
  };
});
