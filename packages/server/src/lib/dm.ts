import type { FastifyInstance } from "fastify";
import { getDefaultServerId } from "./server.js";

export interface Party {
  id: string;
  type: "human" | "agent";
  handle: string;
  displayName?: string;
}

// 解析一个 handle（用户 handle 或 agent name）为对端实体
export async function resolvePeer(app: FastifyInstance, rawHandle: string): Promise<Party | null> {
  const clean = String(rawHandle).replace(/^@/, "");
  if (!clean) return null;
  const u = await app.pg.query("SELECT id, handle, display_name FROM users WHERE handle = $1", [clean]);
  if (u.rows.length) {
    const r = u.rows[0] as any;
    return { id: String(r.id), type: "human", handle: r.handle, displayName: r.display_name };
  }
  const a = await app.pg.query("SELECT id, name, display_name FROM agents WHERE name = $1", [clean]);
  if (a.rows.length) {
    const r = a.rows[0] as any;
    return { id: String(r.id), type: "agent", handle: r.name, displayName: r.display_name };
  }
  return null;
}

// 确定性 DM 频道名：两个成员 id 排序后拼接（human/agent 通用），保证同一对人永远命中同一频道
export function dmChannelName(idA: string, idB: string): string {
  return "dm_" + [String(idA), String(idB)].sort().join("_");
}

// 找到或创建两个实体之间的 DM 频道，返回频道 id（并确保双方都是成员）
export async function getOrCreateDmChannel(app: FastifyInstance, me: Party, peer: Party): Promise<string> {
  const name = dmChannelName(me.id, peer.id);
  const existing = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
  let channelId: string;
  if (existing.rows.length) {
    channelId = String((existing.rows[0] as any).id);
  } else {
    // server_id：优先取 agent 一方所属组织，否则退回默认服务器
    let serverId: string | null = null;
    const agentParty = me.type === "agent" ? me : peer.type === "agent" ? peer : null;
    if (agentParty) {
      const r = await app.pg.query("SELECT server_id FROM agents WHERE id = $1", [agentParty.id]);
      serverId = (r.rows[0] as any)?.server_id ?? null;
    }
    if (!serverId) {
      serverId = await getDefaultServerId(app);
    }
    // created_by 外键指向 users：仅当存在人类一方时填，agent↔agent 留空
    const createdBy = me.type === "human" ? me.id : peer.type === "human" ? peer.id : null;
    try {
      const ins = await app.pg.query(
        "INSERT INTO channels (server_id, name, description, type, created_by) VALUES ($1, $2, '', 'dm', $3) RETURNING id",
        [serverId, name, createdBy]
      );
      channelId = String((ins.rows[0] as any).id);
    } catch {
      // 并发竞态：他人已建 —— 重新查
      const again = await app.pg.query("SELECT id FROM channels WHERE name = $1", [name]);
      channelId = String((again.rows[0] as any).id);
    }
  }
  for (const m of [me, peer]) {
    await app.pg.query(
      "INSERT INTO channel_members (channel_id, member_id, member_type, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING",
      [channelId, m.id, m.type]
    );
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
 */
export async function resolveDmTarget(
  app: FastifyInstance,
  me: Party,
  target: string
): Promise<{ channelId: string; peer?: Party } | null> {
  const body = target.slice(3); // 去掉 "dm:"
  const first = body.split(":")[0];
  if (first.startsWith("@")) {
    const peer = await resolvePeer(app, first);
    if (!peer) return null;
    const channelId = await getOrCreateDmChannel(app, me, peer);
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
  senderId: string
): Promise<{ agents: Party[]; humans: Party[] }> {
  const r = await app.pg.query(
    `SELECT cm.member_id, cm.member_type,
            COALESCE(u.handle, a.name) as handle,
            COALESCE(u.display_name, a.display_name) as display_name
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
      WHERE cm.channel_id = $1 AND cm.member_id::text <> $2`,
    [channelId, String(senderId)]
  );
  const agents: Party[] = [];
  const humans: Party[] = [];
  for (const row of r.rows as any[]) {
    const p: Party = { id: String(row.member_id), type: row.member_type, handle: row.handle, displayName: row.display_name };
    if (row.member_type === "agent") agents.push(p);
    else humans.push(p);
  }
  return { agents, humans };
}

// 从某成员视角，取 DM 频道里的「对端」handle（用于 agent 回复 target=dm:@handle）
export async function dmPeerHandleFor(
  app: FastifyInstance,
  channelId: string,
  selfId: string
): Promise<string | null> {
  const r = await app.pg.query(
    `SELECT COALESCE(u.handle, a.name) as handle
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
      WHERE cm.channel_id = $1 AND cm.member_id::text <> $2
      LIMIT 1`,
    [channelId, String(selfId)]
  );
  return (r.rows[0] as any)?.handle ?? null;
}
