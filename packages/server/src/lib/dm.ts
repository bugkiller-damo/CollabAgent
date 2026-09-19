import type { FastifyInstance } from "fastify";
import { invalidateMember } from "./access.js";
import { getDefaultServerId } from "./server.js";

export interface Party {
  id: string;
  type: "human" | "agent";
  handle: string;
  displayName?: string;
}

// 解析一个 handle（用户 handle 或 agent name）为对端实体。
// serverId（可选）：agent name 只在 server 内唯一（idx_agents_server_name），显式租户下
// 必须带 serverId 解析，否则同名 agent 会跨社区串号（O3）。用户 handle 全局唯一，不受影响。
// meId（可选，DM 语境）：serverId 范围内解析不到 agent 时的兜底——
// 依次找「我自己的 agent」（跨 server，DM 发起语义本就指我的 agent）与
// 「与我共享任一 server 的 agent」。不放宽 user/频道解析，仅限 DM 对端消歧。
export async function resolvePeer(
  app: FastifyInstance,
  rawHandle: string,
  serverId?: string | null,
  meId?: string | null,
): Promise<Party | null> {
  const clean = String(rawHandle).replace(/^@/, "");
  if (!clean) return null;
  const u = await app.pg.query<{ id: number; handle: string; display_name: string | null }>(
    "SELECT id, handle, display_name FROM users WHERE handle = $1",
    [clean],
  );
  if (u.rows.length) {
    const r = u.rows[0];
    return { id: String(r.id), type: "human", handle: r.handle, displayName: r.display_name ?? undefined };
  }
  const a = serverId
    ? await app.pg.query<{ id: number; name: string; display_name: string | null }>(
        "SELECT id, name, display_name FROM agents WHERE name = $1 AND server_id = $2",
        [clean, serverId],
      )
    : await app.pg.query<{ id: number; name: string; display_name: string | null }>(
        "SELECT id, name, display_name FROM agents WHERE name = $1",
        [clean],
      );
  if (a.rows.length) {
    const r = a.rows[0];
    return { id: String(r.id), type: "agent", handle: r.name, displayName: r.display_name ?? undefined };
  }
  // 兜底仅在「显式 server 范围解析失败 + 知道我是谁」时启用——
  // 自己的 agent 优先于同 server 他人的同名 agent
  if (serverId && meId) {
    const fb = await app.pg.query<{ id: number; name: string; display_name: string | null }>(
      `SELECT a.id, a.name, a.display_name FROM agents a
        WHERE a.name = $1 AND (
          a.user_id::text = $2
          OR EXISTS (SELECT 1 FROM server_members sm
                      WHERE sm.server_id = a.server_id AND sm.user_id::text = $2)
        )
        ORDER BY (a.user_id::text = $2) DESC
        LIMIT 1`,
      [clean, meId],
    );
    if (fb.rows.length) {
      const r = fb.rows[0];
      return { id: String(r.id), type: "agent", handle: r.name, displayName: r.display_name ?? undefined };
    }
  }
  return null;
}

// 确定性 DM 频道名：两个成员 id 排序后拼接（human/agent 通用），保证同一对人永远命中同一频道
export function dmChannelName(idA: string, idB: string): string {
  return "dm_" + [String(idA), String(idB)].sort().join("_");
}

// 找到或创建两个实体之间的 DM 频道，返回频道 id（并确保双方都是成员）。
// serverId（可选）：调用方的租户语境（显式 server），仅参与「新建」频道的落点
// 决策——dm_<idA>_<idB> 全局唯一，已存在的频道位置不动。
// 已知取舍：对端退出 dm 所在 server 后，其 /dms 在该 server 语境下不再列出该
// 会话（显式租户的成员校验先拒；channel_members 行仍在，重回 server 即恢复），
// 直接拿 channelId 访问不受 server 边界影响——server 边界的一致代价。
export async function getOrCreateDmChannel(
  app: FastifyInstance,
  me: Party,
  peer: Party,
  serverId?: string | null,
): Promise<string> {
  const name = dmChannelName(me.id, peer.id);
  const existing = await app.pg.query<{ id: number }>("SELECT id FROM channels WHERE name = $1", [name]);
  let channelId: string;
  if (existing.rows.length) {
    channelId = String(existing.rows[0].id);
  } else {
    // server_id：有 agent 一方仍取 agent 所属组织（agent 的 DM 天然属于 agent
    // 所在 server）；human↔human 走三级落点（见下）；兜底默认服务器。
    let targetServerId: string | null = null;
    const agentParty = me.type === "agent" ? me : peer.type === "agent" ? peer : null;
    if (agentParty) {
      const r = await app.pg.query<{ server_id: number }>("SELECT server_id FROM agents WHERE id = $1", [
        agentParty.id,
      ]);
      if (r.rows[0]) targetServerId = String(r.rows[0].server_id);
    } else {
      // human↔human ①：调用方语境 server 且双方都是成员 → 会话停进当前 server
      if (serverId) {
        const both = await app.pg.query<{ n: number }>(
          `SELECT COUNT(DISTINCT user_id)::int AS n FROM server_members
            WHERE server_id = $1 AND user_id::text IN ($2, $3)`,
          [serverId, me.id, peer.id],
        );
        if ((both.rows[0]?.n ?? 0) === 2) targetServerId = serverId;
      }
      // human↔human ②：双方共有的最早私有 server（is_public 广场不算「共有」——
      // 全员共有会让此级恒命中广场而架空本级，兜底交给 ③；2026-09-19 personal
      // 特例取消后所有私有 server 同口径参与）
      if (!targetServerId) {
        const shared = await app.pg.query<{ server_id: string }>(
          `SELECT a.server_id FROM server_members a
             JOIN server_members b ON b.server_id = a.server_id
             JOIN servers s ON s.id = a.server_id
            WHERE a.user_id::text = $1 AND b.user_id::text = $2
              AND s.is_public = false
            ORDER BY s.created_at ASC
            LIMIT 1`,
          [me.id, peer.id],
        );
        if (shared.rows[0]) targetServerId = String(shared.rows[0].server_id);
      }
    }
    // human↔human ③（以及 agent server 缺失的兜底）：默认社区=广场，全员成员恒成立
    if (!targetServerId) {
      targetServerId = await getDefaultServerId(app);
    }
    // created_by 外键指向 users：仅当存在人类一方时填，agent↔agent 留空
    const createdBy = me.type === "human" ? me.id : peer.type === "human" ? peer.id : null;
    try {
      const ins = await app.pg.query<{ id: number }>(
        "INSERT INTO channels (server_id, name, description, type, created_by) VALUES ($1, $2, '', 'dm', $3) RETURNING id",
        [targetServerId, name, createdBy],
      );
      channelId = String(ins.rows[0].id);
    } catch {
      // 并发竞态：他人已建 —— 重新查
      const again = await app.pg.query<{ id: number }>("SELECT id FROM channels WHERE name = $1", [name]);
      channelId = String(again.rows[0].id);
    }
  }
  for (const m of [me, peer]) {
    await app.pg.query(
      "INSERT INTO channel_members (channel_id, member_id, member_type, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING",
      [channelId, m.id, m.type],
    );
    invalidateMember(channelId, m.id); // O7：DM 双方立即可访问，不等 TTL
  }
  return channelId;
}

// 是否 DM 目标串（dm:@handle / dm:<uuid> [: 线程后缀]）
export function isDmTarget(target: string): boolean {
  return typeof target === "string" && target.startsWith("dm:");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 把一个 DM 目标串解析成频道 id（相对调用方 me）。
 * 支持：dm:@handle、dm:@handle:threadShortId、dm:<uuid>、dm:<uuid>:threadShortId
 * 返回 { channelId, peer? }；handle 解析不到对端时返回 null。
 * serverId（可选）：显式租户下把 agent 对端解析限定在该社区（O3）；
 * 同时透传给 getOrCreateDmChannel 作为新建 dm 频道的落点语境。
 */
export async function resolveDmTarget(
  app: FastifyInstance,
  me: Party,
  target: string,
  serverId?: string | null,
): Promise<{ channelId: string; peer?: Party } | null> {
  const body = target.slice(3); // 去掉 "dm:"
  const first = body.split(":")[0];
  if (first.startsWith("@")) {
    const peer = await resolvePeer(app, first, serverId, me.id);
    if (!peer) return null;
    const channelId = await getOrCreateDmChannel(app, me, peer, serverId);
    return { channelId, peer };
  }
  if (UUID_RE.test(first)) {
    return { channelId: first };
  }
  return null;
}

// 取 DM 频道里「除某发送者外」的成员，供投递/唤醒使用
export async function dmOtherMembers(
  app: FastifyInstance,
  channelId: string,
  senderId: string,
): Promise<{ agents: Party[]; humans: Party[] }> {
  const r = await app.pg.query<{ member_id: string; member_type: string; handle: string; display_name: string | null }>(
    `SELECT cm.member_id, cm.member_type,
            COALESCE(u.handle, a.name) as handle,
            COALESCE(u.display_name, a.display_name) as display_name
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
      WHERE cm.channel_id = $1 AND cm.member_id::text <> $2
        AND (cm.member_type <> 'agent' OR a.duty = 'on')`,
    [channelId, String(senderId)],
  );
  const agents: Party[] = [];
  const humans: Party[] = [];
  for (const row of r.rows) {
    const p: Party = {
      id: String(row.member_id),
      type: row.member_type as "human" | "agent",
      handle: row.handle,
      displayName: row.display_name ?? undefined,
    };
    if (row.member_type === "agent") agents.push(p);
    else humans.push(p);
  }
  return { agents, humans };
}

// 从某成员视角，取 DM 频道里的「对端」handle（用于 agent 回复 target=dm:@handle）
export async function dmPeerHandleFor(app: FastifyInstance, channelId: string, selfId: string): Promise<string | null> {
  const r = await app.pg.query<{ handle: string }>(
    `SELECT COALESCE(u.handle, a.name) as handle
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
      WHERE cm.channel_id = $1 AND cm.member_id::text <> $2
      LIMIT 1`,
    [channelId, String(selfId)],
  );
  return r.rows[0]?.handle ?? null;
}
