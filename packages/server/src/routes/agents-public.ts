import type { FastifyInstance } from "fastify";
import { sql } from "../db/connection.js";
import { daemonClients, broadcastToDaemons } from "../ws/handler.js";
import { getOrCreatePersonalOrg, getUserOrgIds } from "../lib/orgs.js";

/**
 * runtime_profile 可能是正确的 jsonb 对象，也可能是历史遗留的「双重编码字符串」，统一解析。
 */
function parseRuntimeProfile(v: unknown): { runtime?: string; model?: string } {
  if (!v) return {};
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return {}; } }
  return v as { runtime?: string; model?: string };
}

export async function agentPublicRoutes(app: FastifyInstance) {
  // GET /agents — 列表（按调用者所属组织过滤可见性）
  app.get("/agents", { preHandler: [app.authenticate] }, async (req: any) => {
    const orgIds = await getUserOrgIds(app, req.user.sub);
    if (orgIds.length === 0) return { agents: [] };
    const agents = await app.pg.query<{
      id: string; user_id: string; name: string; display_name: string;
      description: string; avatar_url: string; status: string;
      runtime_profile: unknown; server_id: string; created_at: string;
    }>(
      "SELECT id, user_id, name, display_name, description, avatar_url, status, runtime_profile, server_id, created_at FROM agents WHERE server_id::text = ANY($1) ORDER BY created_at DESC",
      [orgIds]
    );
    return {
      agents: agents.rows.map((a) => {
        const rp = parseRuntimeProfile(a.runtime_profile);
        return {
          ...a, runtime_profile: rp,
          runtime: rp.runtime || "claude",
          model: rp.model || "sonnet",
          isOnline: daemonClients.has(String(a.user_id)),
        };
      }),
    };
  });

  // POST /agents — 创建
  app.post("/agents", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { name, displayName, description, avatarUrl, runtime, model, serverId } = req.body;
    if (!name) return reply.status(400).send({ error: "name required" });

    // serverId 省略 → 落到创建者的个人组织；若指定，必须是创建者所属的组织
    let orgId: string;
    if (serverId) {
      const myOrgs = await getUserOrgIds(app, req.user.sub);
      if (!myOrgs.includes(String(serverId))) return reply.status(403).send({ error: "not a member of that org" });
      orgId = String(serverId);
    } else {
      orgId = await getOrCreatePersonalOrg(app, req.user.sub, req.user.handle);
    }

    const result = await app.pg.query<{ id: string; user_id: string; name: string; display_name: string; description: string; avatar_url: string; runtime_profile: unknown }>(
      "INSERT INTO agents (user_id, server_id, name, display_name, description, avatar_url, runtime_profile) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *",
      [req.user.sub, orgId, name, displayName || name, description || "", avatarUrl || null, sql.json({ runtime: runtime || "claude", model: model || "sonnet" })]
    );
    const agent = result.rows[0];

    // Auto-start: notify all connected daemons to spawn this agent
    broadcastToDaemons({
      type: "agent:start",
      agent: { id: agent.id, name: agent.name, displayName: agent.display_name, runtime: runtime || "claude", model: model || "sonnet" },
      config: { runtime_profile: agent.runtime_profile },
    });

    return { agent };
  });

  // PATCH /agents/:agentId — 编辑（资料 + 运行时）
  app.patch("/agents/:agentId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { agentId } = req.params;
    const { name, displayName, description, avatarUrl, runtime, model } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (name !== undefined) { sets.push(`name = $${p++}`); params.push(name); }
    if (displayName !== undefined) { sets.push(`display_name = $${p++}`); params.push(displayName); }
    if (description !== undefined) { sets.push(`description = $${p++}`); params.push(description); }
    if (avatarUrl !== undefined) { sets.push(`avatar_url = $${p++}`); params.push(avatarUrl); }
    if (runtime !== undefined || model !== undefined) {
      sets.push(`runtime_profile = $${p++}::jsonb`);
      params.push(sql.json({ runtime: runtime || "claude", model: model || "sonnet" }));
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    const r = await app.pg.query(
      `UPDATE agents SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
      params
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "agent not found" });

    const agent = r.rows[0];
    const rp = parseRuntimeProfile(agent.runtime_profile);
    broadcastToDaemons({
      type: "agent:start",
      agentId: agent.id,
      config: { name: agent.name, displayName: agent.display_name, description: agent.description, runtime: rp.runtime, model: rp.model },
    });
    return { agent: { ...agent, runtime_profile: rp, runtime: rp.runtime, model: rp.model } };
  });

  // DELETE /agents/:agentId — 删除（连带频道成员关系；保留历史消息）
  app.delete("/agents/:agentId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { agentId } = req.params;
    const exists = await app.pg.query("SELECT id FROM agents WHERE id = $1", [agentId]);
    if (exists.rows.length === 0) return reply.status(404).send({ error: "agent not found" });

    await app.pg.query("DELETE FROM channel_members WHERE member_id = $1 AND member_type = 'agent'", [agentId]);
    await app.pg.query("DELETE FROM agents WHERE id = $1", [agentId]);
    broadcastToDaemons({ type: "agent:stop", agentId });
    return { ok: true };
  });
}
