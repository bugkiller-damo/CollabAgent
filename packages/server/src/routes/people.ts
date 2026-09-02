import { agentListFields } from "@collabagent/shared";
import type { FastifyInstance } from "fastify";
import { canAccessChannel } from "../lib/access.js";
import { computerOnlineFor } from "../lib/agent-duty.js";
import { resolvePeer } from "../lib/dm.js";
import { getUserOrgIds } from "../lib/orgs.js";
import { isServerMember, resolveTenant } from "../lib/tenant.js";

const CHANNELS_PREVIEW = 8;
const CHANNELS_ALL = 200;

function parseRuntimeProfile(v: unknown): { runtime?: string; model?: string } {
  if (!v) return {};
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v as { runtime?: string; model?: string };
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

const VISIBLE_CHANNELS_SQL = `
  FROM channel_members cm
  JOIN channels c ON c.id = cm.channel_id
 WHERE cm.member_id = $1
   AND cm.member_type = $2
   AND c.archived = false
   AND (
     c.type = 'public'
     OR EXISTS (
       SELECT 1 FROM channel_members me
        WHERE me.channel_id = c.id
          AND me.member_id::text = $3
          AND me.member_type = 'human'
     )
   )
`;

export async function peopleRoutes(app: FastifyInstance) {
  async function resolveVisiblePeer(req: any, reply: any) {
    const rawHandle = String((req.params as { handle?: string }).handle || "");
    const q = (req.query || {}) as Record<string, string | undefined>;
    const tenant = await resolveTenant(app, req, { serverId: q.serverId });
    if (tenant.explicit && !(await isServerMember(app, tenant.serverId, req.user.sub))) {
      reply.status(403).send({ error: "not a member of that server" });
      return null;
    }
    const peer = await resolvePeer(app, rawHandle, tenant.explicit ? tenant.serverId : undefined);
    if (!peer) {
      reply.status(404).send({ error: "not found" });
      return null;
    }
    if (peer.type === "agent") {
      const a = await app.pg.query<{ server_id: string }>("SELECT server_id FROM agents WHERE id = $1", [peer.id]);
      const serverId = a.rows[0]?.server_id;
      if (!serverId) {
        reply.status(404).send({ error: "not found" });
        return null;
      }
      const orgs = await getUserOrgIds(app, req.user.sub);
      if (!orgs.includes(String(serverId))) {
        reply.status(403).send({ error: "not a member of that org" });
        return null;
      }
    }
    return { peer, tenant, q };
  }

  // GET /api/people/:handle/stats?days=7 — 调用者可见频道内的只读计数。
  app.get("/:handle/stats", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const resolved = await resolveVisiblePeer(req, reply);
    if (!resolved) return;
    const { peer, tenant } = resolved;
    const daysRaw = Number((req.query || {}).days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90 ? Math.floor(daysRaw) : 7;

    const params: unknown[] = [peer.id, peer.type, String(req.user.sub), days];
    let serverFilter = "";
    if (tenant.explicit && tenant.serverId) {
      params.push(tenant.serverId);
      serverFilter = ` AND c.server_id = $${params.length}`;
    }

    const visibleWhere = `
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
     WHERE c.archived = false
       AND m.created_at >= NOW() - ($4::int * INTERVAL '1 day')
       AND (
         c.type = 'public'
         OR EXISTS (
           SELECT 1 FROM channel_members me
            WHERE me.channel_id = c.id
              AND me.member_id::text = $3
              AND me.member_type = 'human'
         )
       )
       ${serverFilter}
    `;

    try {
      const msg = await app.pg.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n ${visibleWhere} AND m.sender_id::text = $1 AND m.sender_type = $2::text`,
        params,
      );
      const open = await app.pg.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n ${visibleWhere}
           AND $2::text IS NOT NULL
           AND m.task_number IS NOT NULL
           AND m.task_assignee::text = $1
           AND m.task_status IN ('todo', 'in_progress', 'in_review')`,
        params,
      );
      const done = await app.pg.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n ${visibleWhere}
           AND $2::text IS NOT NULL
           AND m.task_number IS NOT NULL
           AND m.task_assignee::text = $1
           AND m.task_status IN ('done', 'closed')`,
        params,
      );

      // P1.24：成本接真数据——agent 对端=该 agent 窗口内成本合计；human 对端=名下
      // agents 合计。与消息/任务不同，不做「调用者可见频道」过滤：daemon 账本按
      // 归一化频道名记账（DM 归并 "dm"、未知 "unknown"）无法可靠回链 channel id，
      // 且 agent 对端在 resolveVisiblePeer 已有 org 成员门槛。窗口按 UTC 日对齐账本
      // 口径（daemon utcDay）。无任何成本行时保持 null——web 端 typeof number 才
      // 显示 $ 徽标，恒 0 会让全员挂上 $0.00 噪音。
      const costSql =
        peer.type === "agent"
          ? `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd, COUNT(*)::int AS n
               FROM agent_cost_daily
              WHERE agent_id = $1
                AND day >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ($2::int - 1)`
          : `SELECT COALESCE(SUM(c.cost_usd), 0)::float8 AS usd, COUNT(*)::int AS n
               FROM agent_cost_daily c
               JOIN agents a ON a.id = c.agent_id
              WHERE a.user_id = $1
                AND c.day >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ($2::int - 1)`;
      // 专属两参：postgres.js 对「传入但 SQL 未引用」的参数无法推型（42P18 实测），
      // 不能复用上面 4 参的 params
      const cost = await app.pg.query<{ usd: number; n: number }>(costSql, [peer.id, days]);

      return {
        messages: Number(msg.rows[0]?.n || 0),
        tasksOpen: Number(open.rows[0]?.n || 0),
        tasksDone: Number(done.rows[0]?.n || 0),
        costUsd: Number(cost.rows[0]?.n || 0) > 0 ? Number(cost.rows[0]?.usd || 0) : null,
      };
    } catch (err: any) {
      req.log.error({ err }, "people_stats_failed");
      return reply.status(500).send({ error: err?.message || "stats failed" });
    }
  });

  // GET /api/people/:handle — 人类/Agent 档案只读聚合（P0）。
  // handle 解析顺序与 resolvePeer / DM / @ 一致：先 user.handle，再 agent.name。
  app.get("/:handle", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const resolved = await resolveVisiblePeer(req, reply);
    if (!resolved) return;
    const { peer, tenant, q } = resolved;
    const channelId = q.channelId ? String(q.channelId) : "";
    const wantAllChannels = q.channels === "all";

    let displayName: string | null = peer.displayName ?? null;
    let description: string | null = null;
    let avatarUrl: string | null = null;
    let createdAt = "";
    let runtime: string | undefined;
    let model: string | undefined;
    let isOnline: boolean | undefined;
    let duty: "on" | "off" | undefined;
    let presence: ReturnType<typeof agentListFields>["presence"] | undefined;
    let ownedByMe: boolean | undefined;
    let computer: { id: string; name: string; online: boolean } | null | undefined;

    if (peer.type === "human") {
      const u = await app.pg.query<{
        display_name: string | null;
        description: string | null;
        avatar_url: string | null;
        created_at: unknown;
      }>("SELECT display_name, description, avatar_url, created_at FROM users WHERE id = $1", [peer.id]);
      const row = u.rows[0];
      if (!row) return reply.status(404).send({ error: "not found" });
      displayName = row.display_name;
      description = row.description;
      avatarUrl = row.avatar_url;
      createdAt = iso(row.created_at) || "";
    } else {
      const a = await app.pg.query<{
        user_id: string;
        display_name: string | null;
        description: string | null;
        avatar_url: string | null;
        runtime_profile: unknown;
        created_at: unknown;
        server_id: string;
        duty: string;
      }>(
        "SELECT user_id, display_name, description, avatar_url, runtime_profile, created_at, server_id, duty FROM agents WHERE id = $1",
        [peer.id],
      );
      const row = a.rows[0];
      if (!row) return reply.status(404).send({ error: "not found" });
      const orgs = await getUserOrgIds(app, req.user.sub);
      if (!orgs.includes(String(row.server_id))) {
        return reply.status(403).send({ error: "not a member of that org" });
      }
      displayName = row.display_name;
      description = row.description;
      avatarUrl = row.avatar_url;
      createdAt = iso(row.created_at) || "";
      const rp = parseRuntimeProfile(row.runtime_profile);
      runtime = rp.runtime || "claude";
      model = rp.model || "sonnet";
      const fields = agentListFields(row.duty, computerOnlineFor(String(row.user_id)));
      duty = fields.duty;
      presence = fields.presence;
      isOnline = fields.isOnline;
      ownedByMe = String(row.user_id) === String(req.user.sub);

      const comp = await app.pg.query<{ id: string; name: string; user_id: string }>(
        "SELECT id, name, user_id FROM computers WHERE user_id::text = $1",
        [String(row.user_id)],
      );
      const cr = comp.rows[0];
      if (cr) {
        computer = {
          id: String(cr.id),
          name: cr.name,
          online: computerOnlineFor(String(cr.user_id)),
        };
      }
    }

    let channel: {
      id: string;
      role: string | null;
      isManager: boolean;
      joinedAt: string | null;
    } | null = null;
    if (channelId) {
      if (!(await canAccessChannel(app, channelId, req.user.sub))) {
        return reply.status(403).send({ error: "no access to this channel" });
      }
      const m = await app.pg.query<{ role: string | null; is_manager: boolean; joined_at: unknown }>(
        "SELECT role, is_manager, joined_at FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = $3",
        [channelId, peer.id, peer.type],
      );
      const row = m.rows[0];
      channel = row
        ? { id: channelId, role: row.role, isManager: !!row.is_manager, joinedAt: iso(row.joined_at) }
        : { id: channelId, role: null, isManager: false, joinedAt: null };
    }

    const params: unknown[] = [peer.id, peer.type, String(req.user.sub)];
    let serverFilter = "";
    if (tenant.explicit && tenant.serverId) {
      params.push(tenant.serverId);
      serverFilter = ` AND c.server_id = $${params.length}`;
    }
    const limit = wantAllChannels ? CHANNELS_ALL : CHANNELS_PREVIEW;
    params.push(limit + 1);
    const limitIdx = params.length;

    const chs = await app.pg.query<{
      id: string;
      name: string;
      type: string;
      description: string | null;
      role: string | null;
      is_manager: boolean;
      peer_handle: string | null;
    }>(
      `SELECT c.id, c.name, c.type, c.description, cm.role, cm.is_manager,
              CASE WHEN c.type = 'dm' THEN (
                SELECT COALESCE(u.handle, ag.name)
                  FROM channel_members om
                  LEFT JOIN users u ON om.member_type = 'human' AND u.id = om.member_id
                  LEFT JOIN agents ag ON om.member_type = 'agent' AND ag.id = om.member_id
                 WHERE om.channel_id = c.id
                   AND NOT (om.member_id = $1::uuid AND om.member_type = $2)
                 LIMIT 1
              ) ELSE NULL END AS peer_handle
         ${VISIBLE_CHANNELS_SQL}
          ${serverFilter}
        ORDER BY CASE c.type WHEN 'public' THEN 0 WHEN 'private' THEN 1 ELSE 2 END,
                 c.name
        LIMIT $${limitIdx}`,
      params,
    );
    const overflow = chs.rows.length > limit;
    const channels = chs.rows.slice(0, limit).map((r) => ({
      id: String(r.id),
      name: r.name,
      role: r.role,
      isManager: !!r.is_manager,
      type: (r.type === "private" || r.type === "dm" ? r.type : "public") as "public" | "private" | "dm",
      description: r.description || null,
      peerHandle: r.peer_handle || null,
    }));

    const lastParams: unknown[] = [peer.id, peer.type, String(req.user.sub)];
    let lastServerFilter = "";
    if (tenant.explicit && tenant.serverId) {
      lastParams.push(tenant.serverId);
      lastServerFilter = ` AND c.server_id = $${lastParams.length}`;
    }
    const last = await app.pg.query<{ created_at: unknown }>(
      `SELECT m.created_at
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
        WHERE m.sender_id = $1
          AND m.sender_type = $2
          AND c.archived = false
          AND (
            c.type = 'public'
            OR c.type = 'dm'
            OR EXISTS (
              SELECT 1 FROM channel_members me
               WHERE me.channel_id = c.id
                 AND me.member_id::text = $3
                 AND me.member_type = 'human'
            )
          )
          ${lastServerFilter}
        ORDER BY m.created_at DESC
        LIMIT 1`,
      lastParams,
    );

    return {
      type: peer.type,
      id: peer.id,
      handle: peer.handle,
      displayName,
      description,
      avatarUrl,
      createdAt,
      lastMessageAt: iso(last.rows[0]?.created_at),
      ...(peer.type === "agent"
        ? { runtime, model, isOnline, duty, presence, ownedByMe: !!ownedByMe, computer: computer ?? null }
        : { ownedByMe: String(peer.id) === String(req.user.sub) }),
      channel,
      channels,
      channelsHasMore: !wantAllChannels && overflow,
      channelsCapped: wantAllChannels && overflow,
    };
  });
}
