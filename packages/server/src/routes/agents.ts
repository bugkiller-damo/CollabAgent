import type { FastifyInstance } from "fastify";
import { requireOwnAgent } from "../lib/agent-helpers.js";
import { cleanChannelName } from "../lib/channel.js";
import { getUserOrgIds } from "../lib/orgs.js";
import { getDefaultServerId } from "../lib/server.js";
import { getTenantHostMap } from "../lib/tenant.js";

/**
 * join/leave 共用的租户安全频道解析（评估报告 P0.4）。
 *
 * 频道名只在 (server_id, lower(name)) 内唯一（idx_channels_server_name），裸名
 * `WHERE name=$1` 会跨租户命中其他社区的同名频道——把 agent 加进/踢出别的租户的频道。
 * 解析候选与 resolveTenant 的 O3 豁免哲学对齐：
 *   - agent 自己的 org（同名时优先命中）；
 *   - agent owner 所属的 org；
 *   - 单租户部署（未配置 SERVER_HOST_MAP）下的默认社区——默认社区是开放社区，
 *     公开频道对全体登录用户可见（web 建频道/列频道即走此兜底），join 语义保持一致。
 * 候选之外一律返回 null（调用方回 404），不泄露其他租户频道的存在性。
 */
async function resolveTenantChannel(
  app: FastifyInstance,
  agentId: string,
  ownerUserId: string,
  rawChannelName: string,
): Promise<{ id: string; type: string } | null> {
  const name = cleanChannelName(rawChannelName);
  if (!name) return null;
  const ag = await app.pg.query<{ server_id: string }>("SELECT server_id FROM agents WHERE id = $1", [agentId]);
  const agentServerId = ag.rows[0]?.server_id;
  if (!agentServerId) return null;
  const candidates = new Set<string>([String(agentServerId), ...(await getUserOrgIds(app, ownerUserId))]);
  if (getTenantHostMap().size === 0) {
    const fallback = await getDefaultServerId(app);
    if (fallback) candidates.add(fallback);
  }
  const r = await app.pg.query<{ id: string; type: string }>(
    `SELECT id, type FROM channels
      WHERE name = $1 AND server_id::text = ANY($2)
      ORDER BY (server_id::text = $3) DESC
      LIMIT 1`,
    [name, [...candidates], String(agentServerId)],
  );
  return r.rows[0] ?? null;
}

export async function agentRoutes(app: FastifyInstance) {
  // 旧版 GET /、GET /channel/:id、POST /、PATCH /:agentId 已下线（评估报告 P0.4）：
  // 列表/创建/编辑统一走 /api/agents（org 归属校验 + runtime 校验）；旧 PATCH 更新的
  // 是不存在的 runtime/model 列（必 500 假实现）。频道内 agent 列表走
  // /internal/agent/:agentId/channel-members（requireOwnAgent）。

  // Agent 自主加入/退出公开频道（daemon CLI `slock join/leave` 调用的端点——
  // 此前路由缺失，CLI 调用返回 404 "Not Found"）。
  // 私有频道与人类侧 join 限制一致：必须由频道管理员通过 /api/channels/:id/invite 拉入。
  app.post(
    "/:agentId/channels/:channelName/join",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const { agentId, channelName } = req.params as Record<string, string>;
      const ch = await resolveTenantChannel(app, agentId, String(req.user.sub), channelName);
      if (!ch) return reply.status(404).send({ error: "channel not found" });
      if (ch.type !== "public") {
        return reply.status(403).send({ error: "private channels require an invite from a channel admin" });
      }
      await app.pg.query(
        "INSERT INTO channel_members (channel_id, member_id, member_type, role) VALUES ($1, $2, 'agent', 'member') ON CONFLICT DO NOTHING",
        [ch.id, agentId],
      );
      return { ok: true };
    },
  );

  app.post(
    "/:agentId/channels/:channelName/leave",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const { agentId, channelName } = req.params as Record<string, string>;
      const ch = await resolveTenantChannel(app, agentId, String(req.user.sub), channelName);
      if (!ch) return reply.status(404).send({ error: "channel not found" });
      await app.pg.query(
        "DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent'",
        [ch.id, agentId],
      );
      return { ok: true };
    },
  );

  // Profile (self or others)
  app.get("/:agentId/profile", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { target } = req.query as Record<string, string>;
    if (target) {
      const handle = target.replace(/^@/, "");
      const u = await app.pg.query(
        "SELECT handle, display_name, description, avatar_url FROM users WHERE handle = $1",
        [handle],
      );
      if (u.rows.length) return { type: "human", ...u.rows[0] };
      const a = await app.pg.query(
        "SELECT name as handle, display_name, description, avatar_url FROM agents WHERE name = $1",
        [handle],
      );
      if (a.rows.length) return { type: "agent", ...a.rows[0] };
      return reply.status(404).send({ error: "profile not found" });
    }
    const self = await app.pg.query(
      "SELECT name as handle, display_name, description, avatar_url FROM agents WHERE id = $1",
      [agentId],
    );
    if (self.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    return { type: "agent", ...self.rows[0] };
  });

  // Update profile
  app.post("/:agentId/profile", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { displayName, description } = req.body as { displayName?: string; description?: string };
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (displayName !== undefined) {
      sets.push(`display_name = $${p++}`);
      params.push(displayName);
    }
    if (description !== undefined) {
      sets.push(`description = $${p++}`);
      params.push(description);
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    const r = await app.pg.query(
      `UPDATE agents SET ${sets.join(", ")} WHERE id = $${p} RETURNING name as handle, display_name, description`,
      params,
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    return { type: "agent", ...r.rows[0] };
  });
}
