import {
  type AgentDuty,
  type AgentPresence,
  agentListFields,
  composePresence,
  parseAgentDuty,
  type WsToBrowserMessage,
} from "@collabagent/shared";
import { sendToDaemon, sendToUser } from "../ws/handler.js";
import { appendEvent } from "./audit.js";
// P1.27：读路径跨实例化——daemon 可能连在其他实例上，本实例 Map 之外的在线状态
// 由 lib/presence.ts 的 Redis 并集缓存补齐（未配 VALKEY_URL 时退化为纯本地，行为不变）。
import { isComputerOnline } from "./presence.js";

export { composePresence, parseAgentDuty };

export function computerOnlineFor(userId: string): boolean {
  return isComputerOnline(String(userId));
}

export function decorateAgentPresence<T extends { user_id?: unknown; userId?: unknown; duty?: unknown }>(
  row: T,
  runtime?: string | null,
): T & { duty: AgentDuty; presence: AgentPresence; isOnline: boolean } {
  const owner = String(row.user_id ?? row.userId ?? "");
  const fields = agentListFields(row.duty as string | undefined, computerOnlineFor(owner), runtime);
  return { ...row, ...fields };
}

export function presencePayload(input: {
  agentId: string;
  agentName: string;
  duty: AgentDuty | string;
  ownerUserId: string;
  runtime?: string | null;
}): {
  type: "agent:presence";
  agentId: string;
  agentName: string;
  duty: AgentDuty;
  computerOnline: boolean;
  presence: AgentPresence;
} {
  const duty = parseAgentDuty(input.duty);
  const computerOnline = computerOnlineFor(input.ownerUserId);
  return {
    type: "agent:presence",
    agentId: input.agentId,
    agentName: input.agentName,
    duty,
    computerOnline,
    presence: composePresence(duty, computerOnline, input.runtime),
  };
}

type Queryable = {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  transaction?: <T>(fn: (tx: { query: Queryable["query"] }) => Promise<T>) => Promise<T>;
};

/** 向该 agent 所在组织的在线浏览器推 presence（People / Computer / 档案都要听到）。 */
export async function broadcastAgentPresence(
  pg: Queryable,
  input: {
    agentId: string;
    agentName: string;
    duty: AgentDuty | string;
    ownerUserId: string;
    serverId?: string | null;
    runtime?: string | null;
  },
): Promise<void> {
  const event = presencePayload(input);
  const recipients = new Set<string>([String(input.ownerUserId)]);
  let serverId = input.serverId;
  if (!serverId) {
    const r = await pg.query<{ server_id: string }>("SELECT server_id FROM agents WHERE id = $1", [input.agentId]);
    serverId = r.rows[0]?.server_id;
  }
  try {
    if (serverId) {
      const members = await pg.query<{ user_id: string }>("SELECT user_id FROM server_members WHERE server_id = $1", [
        serverId,
      ]);
      for (const m of members.rows) recipients.add(String(m.user_id));
    }
    // 频道同事补投：agent 被邀请进频道后，频道内其他用户通常不在 agent 所在 org（默认落在
    // 主人私有空间），org 广播到不了他们——按 channel_members 共频道人类成员补投，
    // AgentStatusBar（members 快照 + agent:presence 实时覆盖）才能随停班/回班/离线刷新。
    const coMembers = await pg.query<{ member_id: string }>(
      `SELECT DISTINCT cm2.member_id FROM channel_members cm1
         JOIN channel_members cm2 ON cm2.channel_id = cm1.channel_id AND cm2.member_type = 'human'
        WHERE cm1.member_id = $1 AND cm1.member_type = 'agent'`,
      [input.agentId],
    );
    for (const r of coMembers.rows) recipients.add(String(r.member_id));
  } catch {
    /* 广播失败不挡写路径 */
  }
  for (const uid of recipients) sendToUser(uid, event);
}

/**
 * daemon 上报的 agent:status 向「频道同事」（与 agent 共频道的人类成员）补投。
 * 此前只投 owner 浏览器（ws/handler.ts），非主人的频道状态栏只能停在 members 快照层
 * （空闲/停班），看不到「工作中」实时跳动。
 *
 * 两条边界：
 * - owner 维度收口（a.user_id = ownerUserId）：daemon 帧里的 agentId/agentName 不可信，
 *   不许借 status 事件把状态扇出到他人 agent 的频道；
 * - detail 是最后一行输出片段，可能含其它频道/DM 的内容——非 owner 收件人剥掉，
 *   状态共享、内容不共享。
 */
export async function sendAgentStatusToChannelPeers(
  pg: Queryable | null | undefined,
  ownerUserId: string,
  msg: Extract<WsToBrowserMessage, { type: "agent:status" }>,
): Promise<void> {
  if (!pg) return;
  try {
    const rows = await pg.query<{ uid: string }>(
      `SELECT DISTINCT cm2.member_id AS uid
         FROM agents a
         JOIN channel_members cm1 ON cm1.member_id = a.id AND cm1.member_type = 'agent'
         JOIN channel_members cm2 ON cm2.channel_id = cm1.channel_id AND cm2.member_type = 'human'
        WHERE a.user_id::text = $1 AND (a.id::text = $2 OR a.name = $3)`,
      [String(ownerUserId), String(msg.agentId || ""), String(msg.agentName || "")],
    );
    const stripped: typeof msg = { ...msg, detail: "" };
    for (const r of rows.rows) {
      const uid = String(r.uid);
      if (uid === String(ownerUserId)) continue; // owner 已拿全量帧
      sendToUser(uid, stripped);
    }
  } catch {
    /* 状态扇出失败不挡 daemon 链路 */
  }
}

/** daemon 上下线：重算该 owner 名下全部 agent 的 presence。 */
export async function broadcastOwnerPresence(pg: Queryable | null | undefined, ownerUserId: string): Promise<void> {
  if (!pg) return;
  try {
    const rows = await pg.query<{ id: string; name: string; duty: string; server_id: string }>(
      "SELECT id, name, duty, server_id FROM agents WHERE user_id::text = $1",
      [String(ownerUserId)],
    );
    for (const a of rows.rows) {
      await broadcastAgentPresence(pg, {
        agentId: String(a.id),
        agentName: a.name,
        duty: a.duty,
        ownerUserId,
        serverId: String(a.server_id),
      });
    }
  } catch (err) {
    console.warn("[duty] broadcast owner presence failed:", (err as Error)?.message ?? err);
  }
}

export async function setAgentDuty(
  pg: Queryable & { transaction: NonNullable<Queryable["transaction"]> },
  input: { agentId: string; duty: AgentDuty; actorId: string },
): Promise<{
  id: string;
  name: string;
  user_id: string;
  server_id: string;
  duty: AgentDuty;
  presence: AgentPresence;
  computerOnline: boolean;
  isOnline: boolean;
}> {
  const row = await pg.transaction(async (tx) => {
    const updated = await tx.query<{
      id: string;
      name: string;
      user_id: string;
      server_id: string;
      duty: string;
    }>("UPDATE agents SET duty = $1, updated_at = now() WHERE id = $2 RETURNING id, name, user_id, server_id, duty", [
      input.duty,
      input.agentId,
    ]);
    const agent = updated.rows[0];
    if (!agent) return null;
    await appendEvent(tx, {
      actorId: input.actorId,
      actorType: "human",
      verb: input.duty === "on" ? "agent.duty_on" : "agent.duty_off",
      objectType: "agent",
      objectId: input.agentId,
      payload: { name: agent.name, duty: input.duty },
    });
    return agent;
  });
  if (!row) {
    const err = new Error("agent not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  const duty = parseAgentDuty(row.duty);
  const computerOnline = computerOnlineFor(String(row.user_id));
  const presence = composePresence(duty, computerOnline);
  sendToDaemon(String(row.user_id), {
    type: "agent:duty",
    agentId: String(row.id),
    name: row.name,
    duty,
  });
  await broadcastAgentPresence(pg, {
    agentId: String(row.id),
    agentName: row.name,
    duty,
    ownerUserId: String(row.user_id),
    serverId: String(row.server_id),
  });
  return {
    id: String(row.id),
    name: row.name,
    user_id: String(row.user_id),
    server_id: String(row.server_id),
    duty,
    presence,
    computerOnline,
    isOnline: presence === "idle" || presence === "starting" || presence === "working",
  };
}
