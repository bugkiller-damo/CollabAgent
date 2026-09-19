import type { WsToBrowserMessage } from "@collabagent/shared";
import { sendToUser } from "../ws/handler.js";

type Queryable = {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

/**
 * 资料变更（handle/显示名/头像）广播——PATCH /agents/:id 与 PATCH /profile 成功后调用。
 * web 端 wsDispatch 就地回写 channelStore.membersByChannelId，成员面板 / AgentStatusBar /
 * 消息行头像随之更新，不落刷新。
 *
 * 收件人口径与 broadcastAgentPresence 一致（同一份「谁能看见该成员」答案）：
 * - agent：属主 + 所在 server 成员 + 共频道人类同事——被邀请入频道的他人 agent 落在
 *   主人私有 server，org 成员广播到不了频道同事，必须按 channel_members 补投；
 * - human：本人（多端同步——发起端 store 已乐观更新，幂等）+ 其所有 server 的成员 +
 *   共频道人类同事（跨 server 邀请入圈的唯一可达路径）。
 * 收件人解析失败不挡写路径——REST 拉取仍是权威源。
 */
export async function broadcastProfileUpdate(
  pg: Queryable | null | undefined,
  input: {
    memberType: "human" | "agent";
    /** channel_members.member_id 口径：agents.id 或 users.id */
    memberId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    /** agent：属主 user_id；human：与 memberId 相同 */
    ownerUserId: string;
    /** agent 所在 server（缺省时回查 agents 行） */
    serverId?: string | null;
  },
): Promise<void> {
  if (!pg) return;
  const event: WsToBrowserMessage = {
    type: "profile:update",
    memberType: input.memberType,
    memberId: input.memberId,
    handle: input.handle,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
  };
  const recipients = new Set<string>([String(input.ownerUserId)]);
  try {
    if (input.memberType === "agent") {
      let serverId = input.serverId;
      if (!serverId) {
        const r = await pg.query<{ server_id: string }>("SELECT server_id FROM agents WHERE id = $1", [input.memberId]);
        serverId = r.rows[0]?.server_id;
      }
      if (serverId) {
        const members = await pg.query<{ user_id: string }>("SELECT user_id FROM server_members WHERE server_id = $1", [
          serverId,
        ]);
        for (const m of members.rows) recipients.add(String(m.user_id));
      }
    } else {
      // 人类资料变更对「其所在全部 server 的成员」可见（用户可跨多个 server）
      const members = await pg.query<{ user_id: string }>(
        `SELECT DISTINCT sm2.user_id FROM server_members sm1
           JOIN server_members sm2 ON sm2.server_id = sm1.server_id
         WHERE sm1.user_id::text = $1`,
        [input.memberId],
      );
      for (const m of members.rows) recipients.add(String(m.user_id));
    }
    const coMembers = await pg.query<{ member_id: string }>(
      `SELECT DISTINCT cm2.member_id FROM channel_members cm1
         JOIN channel_members cm2 ON cm2.channel_id = cm1.channel_id AND cm2.member_type = 'human'
       WHERE cm1.member_id = $1 AND cm1.member_type = $2`,
      [input.memberId, input.memberType],
    );
    for (const r of coMembers.rows) recipients.add(String(r.member_id));
  } catch {
    /* 广播失败不挡写路径 */
  }
  for (const uid of recipients) sendToUser(uid, event);
}
