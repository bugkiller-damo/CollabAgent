import type { FastifyInstance } from "fastify";
import { sql } from "../db/connection.js";
import { daemonClients, sendToDaemon } from "../ws/handler.js";
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
  // GET /agents — 列表（按调用者所属组织过滤可见性；mine=1 时只返回自己名下的
  // ——daemon loadExistingAgents 用：daemon 只能托管自己账号下的 agent，列出组织里
  // 其它用户的 agent 会导致它误注册、hasAgent() 谎报，真正 spawn 时 403 "not your agent"）
  app.get("/agents", { preHandler: [app.authenticate] }, async (req: any) => {
    const orgIds = await getUserOrgIds(app, req.user.sub);
    if (orgIds.length === 0) return { agents: [] };
    const mine = (req.query as Record<string, string> | undefined)?.mine;
    const params: any[] = [orgIds];
    let filter = "";
    if (mine === "1" || mine === "true") {
      params.push(String(req.user.sub));
      filter = " AND user_id::text = $" + params.length;
    }
    const agents = await app.pg.query<{
      id: string; user_id: string; name: string; display_name: string;
      description: string; avatar_url: string; status: string;
      runtime_profile: unknown; server_id: string; created_at: string;
    }>(
      "SELECT id, user_id, name, display_name, description, avatar_url, status, runtime_profile, server_id, created_at FROM agents WHERE server_id::text = ANY($1)" + filter + " ORDER BY created_at DESC",
      params
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

    // Auto-start: notify this agent's owning daemon to spawn it（不广播——见 agents.ts
    // 对应 call site 的注释：广播会让别的 daemon 误注册这个 agent，hasAgent() 谎报，
    // 真正 @/派发时在 spawn 阶段 403 "not your agent"）。
    sendToDaemon(String(req.user.sub), {
      type: "agent:start",
      agent: { id: agent.id, name: agent.name, displayName: agent.display_name, runtime: runtime || "claude", model: model || "sonnet" },
      config: { runtime_profile: agent.runtime_profile },
    });

    return { agent };
  });

  // PATCH /agents/:agentId — 编辑（资料 + 运行时）
  app.patch("/agents/:agentId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { agentId } = req.params;
    // POST /agents（创建）已经检查了调用者是否属于目标 org；PATCH/DELETE 之前完全没做
    // 同类检查——任何登录用户都能改/删服务器上任意一个 agent。这里补上跟创建端点
    // 一致的 org 归属校验。
    const existing = await app.pg.query<{ server_id: string; user_id: string }>("SELECT server_id, user_id FROM agents WHERE id = $1", [agentId]);
    if (existing.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    const myOrgs = await getUserOrgIds(app, req.user.sub);
    if (!myOrgs.includes(String(existing.rows[0].server_id))) return reply.status(403).send({ error: "not a member of that org" });
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
    sendToDaemon(String(agent.user_id), {
      type: "agent:start",
      agentId: agent.id,
      config: { name: agent.name, displayName: agent.display_name, description: agent.description, runtime: rp.runtime, model: rp.model },
    });
    return { agent: { ...agent, runtime_profile: rp, runtime: rp.runtime, model: rp.model } };
  });

  // DELETE /agents/:agentId — 删除（连带频道成员关系；保留历史消息）
  app.delete("/agents/:agentId", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const { agentId } = req.params;
    const exists = await app.pg.query<{ server_id: string; user_id: string }>("SELECT server_id, user_id FROM agents WHERE id = $1", [agentId]);
    if (exists.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    const myOrgs = await getUserOrgIds(app, req.user.sub);
    if (!myOrgs.includes(String(exists.rows[0].server_id))) return reply.status(403).send({ error: "not a member of that org" });

    await app.pg.query("DELETE FROM channel_members WHERE member_id = $1 AND member_type = 'agent'", [agentId]);
    await app.pg.query("DELETE FROM agents WHERE id = $1", [agentId]);
    sendToDaemon(String(exists.rows[0].user_id), { type: "agent:stop", agentId });
    return { ok: true };
  });
}
