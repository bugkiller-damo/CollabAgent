import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

import { useChannelStore } from "./channelStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

// 未读计数 key 约定 = "<serverId>:<频道裸名>"（serverId 为空时退化为 ":<名>"）——
// 跨 server 同名频道（两边都有 general）不串桶；写/清/读三侧统一走 unreadKeyFor
// （P1-9 教训延续：wsDispatch 写、ChatPane 读、setActiveChannel 清单点归一化）
describe("channelStore 未读计数 key 归一化", () => {
  it("incrementUnread 去 # 前缀：同 server 下 '#general' 与 'general' 落同 key", () => {
    const store = useChannelStore();
    store.incrementUnread("s1", "#general");
    store.incrementUnread("s1", "general");

    expect(store.unreadCounts["s1:general"]).toBe(2);
    expect(store.unreadCounts["s1:#general"]).toBeUndefined();
  });

  it("不同 server 同名频道分桶，互不干扰", () => {
    const store = useChannelStore();
    store.incrementUnread("s1", "general");
    store.incrementUnread("s2", "general");
    store.incrementUnread("s2", "general");

    expect(store.unreadCounts["s1:general"]).toBe(1);
    expect(store.unreadCounts["s2:general"]).toBe(2);
  });

  it("clearUnread 按 (serverId, name) 清：其他 server 同名频道不受影响", () => {
    const store = useChannelStore();
    store.incrementUnread("s1", "general");
    store.incrementUnread("s2", "general");

    store.clearUnread("s1", "#general");
    expect(store.unreadCounts["s1:general"]).toBe(0);
    expect(store.unreadCounts["s2:general"]).toBe(1);
  });

  it("setActiveChannel 用 store.serverId 清当前 server 的未读", () => {
    const store = useChannelStore();
    store.resetForServer("s1");
    store.incrementUnread("s1", "random");
    store.incrementUnread("s2", "random");

    store.setActiveChannel("random");
    expect(store.unreadCounts["s1:random"]).toBe(0);
    expect(store.unreadCounts["s2:random"]).toBe(1);
    expect(store.activeChannelName).toBe("random");
  });

  it("无 serverId（单租户/未解析广播）退化为 ':name' key，读写同口径", () => {
    const store = useChannelStore();
    store.incrementUnread(null, "general");

    expect(store.unreadCounts[":general"]).toBe(1);
    expect(store.unreadKeyFor(null, "#general")).toBe(":general");
  });
});

// 资料变更就地回写（profile:update / 本地保存共用 applyMemberProfile）：
// 成员面板 / AgentStatusBar / 消息行头像都读 membersByChannelId，回写即同步
describe("channelStore 成员资料回写", () => {
  function seed(store: ReturnType<typeof useChannelStore>) {
    store.membersByChannelId = {
      c1: [
        {
          member_id: "a-1",
          member_type: "agent",
          handle: "bot",
          display_name: "机器人",
          avatar_url: "/avatars/old.svg",
        },
        { member_id: "u-1", member_type: "human", handle: "me", display_name: "我", avatar_url: null },
      ],
      c2: [
        {
          member_id: "a-1",
          member_type: "agent",
          handle: "bot",
          display_name: "机器人",
          avatar_url: "/avatars/old.svg",
        },
      ],
      c3: [{ member_id: "u-2", member_type: "human", handle: "other", avatar_url: "/avatars/x.svg" }],
    };
  }

  it("applyMemberProfile 跨频道就地回写同 (type,id) 成员行", () => {
    const store = useChannelStore();
    seed(store);

    store.applyMemberProfile({
      memberType: "agent",
      memberId: "a-1",
      displayName: "新名字",
      avatarUrl: "/avatars/new.svg",
    });

    for (const cid of ["c1", "c2"]) {
      const m = store.membersByChannelId[cid]!.find((x) => x.member_id === "a-1")!;
      expect(m.display_name).toBe("新名字");
      expect(m.avatar_url).toBe("/avatars/new.svg");
    }
    // 不同 id / 不同 type 的行不动
    expect(store.membersByChannelId.c1![1].avatar_url).toBeNull();
    expect(store.membersByChannelId.c3![0].avatar_url).toBe("/avatars/x.svg");
  });

  it("avatarUrl: null 显式清空（成员行回字母兜底）", () => {
    const store = useChannelStore();
    seed(store);

    store.applyMemberProfile({ memberType: "agent", memberId: "a-1", avatarUrl: null });

    expect(store.membersByChannelId.c1![0].avatar_url).toBeNull();
    expect(store.membersByChannelId.c2![0].avatar_url).toBeNull();
    // 未下发的字段不触碰
    expect(store.membersByChannelId.c1![0].display_name).toBe("机器人");
  });

  it("avatarUrl 缺省（undefined）不触碰现有头像", () => {
    const store = useChannelStore();
    seed(store);

    store.applyMemberProfile({ memberType: "agent", memberId: "a-1", displayName: "改名" });

    expect(store.membersByChannelId.c1![0].avatar_url).toBe("/avatars/old.svg");
  });

  it("无命中成员行也递增 membersVersion（自持副本视图靠它触发重拉）", () => {
    const store = useChannelStore();
    seed(store);
    const v = store.membersVersion;

    store.applyMemberProfile({ memberType: "human", memberId: "nobody", avatarUrl: "/x.svg" });

    expect(store.membersVersion).toBe(v + 1);
  });

  it("memberAvatarUrl 按 (channelId, senderId, senderType) 解析；缺缓存/缺 senderType 兜底", () => {
    const store = useChannelStore();
    seed(store);

    expect(store.memberAvatarUrl("c1", "a-1", "agent")).toBe("/avatars/old.svg");
    // senderType 缺省按 human 解析（消息负载 senderType 恒有，防御缺省）
    expect(store.memberAvatarUrl("c3", "u-2", undefined)).toBe("/avatars/x.svg");
    // 未缓存频道 / 未知发送者 / 空头像 → undefined（Avatar 回字母兜底）
    expect(store.memberAvatarUrl("c-unknown", "a-1", "agent")).toBeUndefined();
    expect(store.memberAvatarUrl("c1", "ghost", "agent")).toBeUndefined();
    expect(store.memberAvatarUrl("c1", "u-1", "human")).toBeUndefined();
    expect(store.memberAvatarUrl(undefined, "a-1", "agent")).toBeUndefined();
  });
});
