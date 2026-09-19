import type { FastifyInstance } from "fastify";
import { isDmTarget, type Party, resolveDmTarget } from "./dm.js";
import { getUserOrgIds } from "./orgs.js";
import { getDefaultServerId } from "./server.js";
import { getTenantHostMap, isServerMember } from "./tenant.js";

export async function getAgent(app: FastifyInstance, agentId: string): Promise<any | null> {
  const r = await app.pg.query(
    "SELECT id, user_id, name, display_name, avatar_url, server_id, computer_id, last_seen_seq FROM agents WHERE id = $1",
    [agentId],
  );
  return r.rows[0] || null;
}

/**
 * 归属校验 preHandler：任何有效的 sk_machine_... token 目前都能直接冒充服务器上
 * 任意用户的任意 agentId 调 /internal/agent/:agentId/* —— app.authenticate 只验证
 * "这个 token 属于哪个人类用户"，从不检查 URL 里的 :agentId 是否真的属于这个用户。
 * 这个 preHandler 补上这道检查，跟在 app.authenticate 后面用：
 * `{ preHandler: [app.authenticate, requireOwnAgent] }`
 */
export async function requireOwnAgent(request: any, reply: any): Promise<void> {
  const agentId = (request.params as Record<string, string>).agentId;
  const agent = await getAgent(request.server, agentId);
  if (!agent) {
    reply.status(404).send({ error: "agent not found" });
    return;
  }
  if (String(agent.user_id) !== String(request.user.sub)) {
    reply.status(403).send({ error: "not your agent" });
    return;
  }
}

export async function agentCanAccessChannel(
  app: FastifyInstance,
  channelId: string,
  agentId: string,
): Promise<boolean> {
  const r = await app.pg.query<{ type: string; server_id: string }>(
    "SELECT type, server_id::text AS server_id FROM channels WHERE id = $1",
    [channelId],
  );
  const row = r.rows[0];
  if (!row) return false;
  if (row.type === "private" || row.type === "dm") {
    const m = await app.pg.query(
      "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent'",
      [channelId, agentId],
    );
    return m.rows.length > 0;
  }
  // 2026-09-17 审计收紧：公开频道不再无条件放行——与人类侧 canAccessChannel 同口径，
  // agent 属主须为频道所在 server 的成员（封死「持 scoped token 的 agent 写任意
  // 社区公开频道」与多租户跨社区同名频道串号两个面）。被邀请/征用入圈的 agent
  // （含跨社区协作邀请）同样放行——与人类侧「频道成员行同放行」一致。
  const ag = await app.pg.query<{ user_id: string }>("SELECT user_id::text AS user_id FROM agents WHERE id = $1", [
    agentId,
  ]);
  if (!ag.rows[0]) return false;
  const am = await app.pg.query(
    "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent'",
    [channelId, agentId],
  );
  if (am.rows.length > 0) return true;
  return isServerMember(app, row.server_id, String(ag.rows[0].user_id));
}

export async function isChannelManager(app: FastifyInstance, channelId: string, agentId: string): Promise<boolean> {
  const m = await app.pg.query(
    "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent' AND is_manager = true",
    [channelId, agentId],
  );
  return m.rows.length > 0;
}

export async function resolveAgentChannelDbId(
  app: FastifyInstance,
  agentId: string,
  channelArg: string,
): Promise<string | null> {
  if (isDmTarget(channelArg)) {
    const ag = await getAgent(app, agentId);
    const me: Party = { id: agentId, type: "agent", handle: ag?.name || "agent" };
    const r = await resolveDmTarget(app, me, channelArg);
    return r?.channelId ?? null;
  }
  // 2026-09-17 审计 F4 修复：频道名解析走 resolveAgentChannelByName 的候选集口径
  const ch = await resolveAgentChannelByName(app, agentId, channelArg, "id");
  return ch?.id ?? null;
}

/**
 * 2026-09-17 审计 F4 修复：agent 视角的频道名解析——候选限定在
 * agent 所属 server ∪ 属主所属 org ∪（单租户部署的）默认社区，
 * 与 agents.ts join/leave 的 resolveTenantChannel 同口径：跨社区同名频道
 * 不再串号，同时不误伤「agent 在私有空间、频道在默认社区」的既有协作流。
 * 命中优先级：agent 自己的 server 置顶。
 */
export async function resolveAgentChannelByName(
  app: FastifyInstance,
  agentId: string,
  channel: string,
  fields = "id, server_id",
): Promise<any | null> {
  const ag = await getAgent(app, agentId);
  if (!ag) return null;
  const candidates = new Set<string>([String(ag.server_id), ...(await getUserOrgIds(app, String(ag.user_id)))]);
  if (getTenantHostMap().size === 0) {
    const fallback = await getDefaultServerId(app);
    if (fallback) candidates.add(fallback);
  }
  const r = await app.pg.query(
    `SELECT ${fields} FROM channels
      WHERE name = $1 AND server_id::text = ANY($2)
      ORDER BY (server_id::text = $3) DESC
      LIMIT 1`,
    [resolveChannelNameOnly(channel), [...candidates], String(ag.server_id)],
  );
  return r.rows[0] ?? null;
}

/** 频道名预清洗（剥 "#" 与线程后缀），供 ANY 候选查询使用 */
function resolveChannelNameOnly(raw: string): string {
  const noHash = raw.startsWith("#") ? raw.slice(1) : raw;
  return noHash.split(":")[0];
}
