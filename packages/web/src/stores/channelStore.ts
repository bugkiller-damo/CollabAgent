import type { AgentDuty, AgentPresence, Channel } from "@collabagent/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { apiGet, apiPatch, apiPost } from "../api";
import { lastChannelKey } from "../lib/nav";
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
  /** 资料变更版本号：profile:update / 本地保存递增——自持副本的视图
   * （PeopleView、AgentStatusBar 的 DM 路径）watch 它重拉，不必逐个注入回写 */
  const membersVersion = ref(0);

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

  /**
   * 按 (member_id, member_type) 就地回写所有已缓存频道的成员行——
   * server 的 profile:update 广播与本地保存（MemberProfileBody/ProfileSettings）共用；
   * 幂等（同值重放无副作用），未缓存的频道不动（下次打开仍走 fetchMembers 权威拉取）。
   */
  function applyMemberProfile(u: {
    memberType: "human" | "agent";
    memberId: string;
    handle?: string;
    displayName?: string;
    avatarUrl?: string | null;
  }): void {
    membersVersion.value++;
    const next = { ...membersByChannelId.value };
    let changed = false;
    for (const cid of Object.keys(next)) {
      const list = next[cid]!;
      if (!list.some((m) => m.member_type === u.memberType && String(m.member_id) === u.memberId)) continue;
      next[cid] = list.map((m) =>
        m.member_type === u.memberType && String(m.member_id) === u.memberId
          ? {
              ...m,
              handle: u.handle ?? m.handle,
              display_name: u.displayName ?? m.display_name,
              avatar_url: u.avatarUrl === undefined ? m.avatar_url : u.avatarUrl,
            }
          : m,
      );
      changed = true;
    }
    if (changed) membersByChannelId.value = next;
  }

  /**
   * 发送者头像解析（消息行/线程行共用）：读成员缓存而非消息负载——成员行被
   * profile:update 就地回写，历史消息的头像也随资料变更同步刷新（负载快照做不到）。
   * senderId 与 channel_members.member_id 同口径（human=users.id / agent=agents.id）。
   */
  function memberAvatarUrl(
    channelId: string | null | undefined,
    senderId: unknown,
    senderType?: unknown,
  ): string | undefined {
    if (!channelId || senderId == null) return undefined;
    const list = membersByChannelId.value[channelId];
    if (!list) return undefined;
    const t = senderType === "agent" ? "agent" : "human";
    const sid = String(senderId);
    return list.find((m) => m.member_type === t && String(m.member_id) === sid)?.avatar_url || undefined;
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

  /**
   * 解析某 server 的落点频道名（切 server / 各类落地页共用）：
   * preferred（如当前活跃频道）→ localStorage 记忆 → 频道列表首个 → 兜底 "general"。
   * 候选项必须仍在该 server 的频道列表里才算命中——新建 server 没有
   * general（只有私有 onboarding-owner），硬编码落点会 404；已归档/删除/
   * 不可见的记忆值同理跳过。私有频道在 /api/server/info 仅对 channel_members
   * 可见，返回列表天然按成员身份过滤，无需特判。
   */
  async function resolveLandingChannel(sid: string, preferred?: string | null): Promise<string> {
    await fetchChannels(sid);
    const list = channels.value;
    const hit = (n?: string | null): n is string => !!n && list.some((c) => c.name === n);
    if (hit(preferred)) return preferred;
    let last: string | null = null;
    try {
      last = typeof localStorage === "undefined" ? null : localStorage.getItem(lastChannelKey(sid));
    } catch {
      /* ignore */
    }
    if (hit(last)) return last;
    return list[0]?.name || "general";
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
    resolveLandingChannel,
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
    membersVersion,
    applyMemberProfile,
    memberAvatarUrl,
    fetchMembers,
  };
});
