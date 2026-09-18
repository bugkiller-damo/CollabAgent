import type { AgentDuty, AgentPresence, Channel } from "@collabagent/shared";
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
  // agent 成员的产品合成态（服务端按 duty × 主人计算机在线算好；人类成员缺省）——
  // 频道状态栏靠它让非主人也看到「空闲/停班/离线」（/api/agents 的 org 口径看不到他人 agent）
  duty?: AgentDuty;
  presence?: AgentPresence;
  isOnline?: boolean;
  avatar_url?: string | null;
}

export const useChannelStore = defineStore("channels", () => {
  const channels = ref<Channel[]>([]);
  const serverId = ref<string | null>(null);
  const joinedChannels = ref<Set<string>>(new Set());
  const activeChannelName = ref<string | null>(null);
  /** 未读计数，key 为 "<serverId>:<channelName>"——跨 server 同名频道不撞 */
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

  async function fetchChannels(sid?: string | null): Promise<void> {
    const target = sid ?? serverId.value;
    try {
      const data = await apiGet<{ channels: Channel[]; serverId?: string }>(
        "/api/server/info",
        target ? { serverId: target } : undefined,
      );
      const chs = data.channels || [];
      channels.value = chs;
      serverId.value = data.serverId || serverId.value;
      joinedChannels.value = new Set(chs.filter((c) => c.joined).map((c) => c.name));
    } catch (err: any) {
      toast.error("加载频道列表失败：" + (err?.message || "网络错误"));
    }
  }

  /** 切换活跃 server：频道列表换成新 server 的上下文，旧列表立即清掉
   * （避免在 server B 的页面短暂显示 server A 的频道） */
  function resetForServer(sid: string | null): void {
    serverId.value = sid;
    channels.value = [];
    joinedChannels.value = new Set();
    activeChannelName.value = null;
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

  async function joinChannel(channelId: string): Promise<void> {
    await apiPost(`/api/channels/${channelId}/join`);
    await fetchChannels();
  }

  async function leaveChannel(channelId: string): Promise<void> {
    await apiPost(`/api/channels/${channelId}/leave`);
    await fetchChannels();
  }

  function setActiveChannel(name: string): void {
    activeChannelName.value = name;
    clearUnread(serverId.value, name);
  }

  // 未读计数 key 约定："<serverId>:<频道裸名>"——跨 server 同名频道不撞；
  // 读侧用 unreadKeyFor(sid, name)，写侧 wsDispatch 按广播里的 serverId 定位。
  // （P1-9 教训：写/读/清三侧必须同一 key 口径，单点收敛防漂移）
  function unreadKeyFor(sid: string | null | undefined, channelName: string): string {
    const name = channelName.startsWith("#") ? channelName.slice(1) : channelName;
    return `${sid ?? ""}:${name}`;
  }

  function incrementUnread(sid: string | null | undefined, channelName: string): void {
    const key = unreadKeyFor(sid, channelName);
    unreadCounts.value = { ...unreadCounts.value, [key]: (unreadCounts.value[key] || 0) + 1 };
  }

  function clearUnread(sid: string | null | undefined, channelName: string): void {
    unreadCounts.value = { ...unreadCounts.value, [unreadKeyFor(sid, channelName)]: 0 };
  }

  return {
    channels,
    serverId,
    joinedChannels,
    activeChannelName,
    unreadCounts,
    fetchChannels,
    resetForServer,
    createChannel,
    updateChannel,
    joinChannel,
    leaveChannel,
    setActiveChannel,
    unreadKeyFor,
    incrementUnread,
    clearUnread,
    membersByChannelId,
    fetchMembers,
  };
});
