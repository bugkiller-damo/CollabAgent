import { parseAgentDuty, WIRED_RUNTIME_IDS } from "@collabagent/shared";
import type { FastifyInstance } from "fastify";
import { sql } from "../db/connection.js";
import { computerOnlineFor, decorateAgentPresence, setAgentDuty } from "../lib/agent-duty.js";
import { requireOwnAgent } from "../lib/agent-helpers.js";
import { getOrCreatePersonalOrg, getUserOrgIds } from "../lib/orgs.js";
import { daemonMeta, requestDaemonWorkspace, sendToDaemon } from "../ws/handler.js";

/**
 * runtime_profile 可能是正确的 jsonb 对象，也可能是历史遗留的「双重编码字符串」，统一解析。
 */
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
      // 必须带表别名：LEFT JOIN computers 后裸写 user_id 会歧义（a/c 两表都有），
      // 曾导致 mine=1 500、daemon 静默注册 0 个 agent（2026-08-24 实锤）。
      filter = " AND a.user_id::text = $" + params.length;
    }
    const agents = await app.pg.query<{
      id: string;
      user_id: string;
      name: string;
      display_name: string;
      description: string;
      avatar_url: string;
      status: string;
      duty: string;
      runtime_profile: unknown;
      server_id: string;
      created_at: string;
      computer_id: string | null;
      computer_name: string | null;
      computer_hostname: string | null;
    }>(
      `SELECT a.id, a.user_id, a.name, a.display_name, a.description, a.avatar_url, a.status, a.duty,
              a.runtime_profile, a.server_id, a.created_at,
              c.id AS computer_id, c.name AS computer_name, c.hostname AS computer_hostname
         FROM agents a
         LEFT JOIN computers c ON c.user_id = a.user_id
        WHERE a.server_id::text = ANY($1)${filter}
        ORDER BY a.created_at DESC`,
      params,
    );
    return {
      agents: agents.rows.map((a) => {
        const rp = parseRuntimeProfile(a.runtime_profile);
        const decorated = decorateAgentPresence(a);
        return {
          ...a,
          ...decorated,
          runtime_profile: rp,
          runtime: rp.runtime || "claude",
          model: rp.model || "sonnet",
          computer: a.computer_id
            ? {
                id: String(a.computer_id),
                name: a.computer_name || a.computer_hostname || "计算机",
                hostname: a.computer_hostname,
                online: computerOnlineFor(String(a.user_id)),
              }
            : null,
        };
      }),
    };
  });

  // POST /agents/:agentId/duty — owner 切换值班意愿
  app.post(
    "/agents/:agentId/duty",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req: any, reply: any) => {
      const { agentId } = req.params as { agentId: string };
      const raw = (req.body || {}).duty;
      if (raw !== "on" && raw !== "off") return reply.status(400).send({ error: "duty must be on or off" });
      try {
        const result = await setAgentDuty(app.pg, { agentId, duty: raw, actorId: String(req.user.sub) });
        return result;
      } catch (err: any) {
        const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
        return reply.status(status).send({ error: err.message || "duty update failed" });
      }
    },
  );

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

    const runtimeId = String(runtime || "claude");
    if (!(WIRED_RUNTIME_IDS as readonly string[]).includes(runtimeId)) {
      return reply.status(400).send({ error: "runtime not wired", runtime: runtimeId });
    }
    const meta = daemonMeta.get(String(req.user.sub));
    if (meta) {
      const probe = meta.runtimes.find((r) => r.id === runtimeId);
      if (probe && probe.status !== "installed") {
        return reply.status(400).send({
          error: probe.status === "not_installed" ? "runtime not installed" : "runtime not wired",
          runtime: runtimeId,
        });
      }
    }

    const result = await app.pg.query<{
      id: string;
      user_id: string;
      name: string;
      display_name: string;
      description: string;
      avatar_url: string;
      runtime_profile: unknown;
    }>(
      "INSERT INTO agents (user_id, server_id, name, display_name, description, avatar_url, runtime_profile) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *",
      [
        req.user.sub,
        orgId,
        name,
        displayName || name,
        description || "",
        avatarUrl || null,
        sql.json({ runtime: runtimeId, model: model || "sonnet" }),
      ],
    );
    const agent = result.rows[0] as any;

    // Auto-start: notify this agent's owning daemon to spawn it（不广播——见 agents.ts
    // 对应 call site 的注释：广播会让别的 daemon 误注册这个 agent，hasAgent() 谎报，
    // 真正 @/派发时在 spawn 阶段 403 "not your agent"）。
    sendToDaemon(String(req.user.sub), {
      type: "agent:start",
      agent: {
        id: agent.id,
        name: agent.name,
        displayName: agent.display_name,
        runtime: runtimeId,
        model: model || "sonnet",
      },
      config: { runtime_profile: agent.runtime_profile },
    });

    return { agent };
  });

  // PATCH /agents/:agentId — 编辑（资料 + 运行时）
  app.patch("/agents/:agentId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req: any, reply: any) => {
    const { agentId } = req.params;
    // P0.11：所有权校验收敛到 requireOwnAgent（与 /internal/agent 侧对齐）。此前只有
    // org 成员校验——共享 org 内任何成员都能改他人 agent（改 runtime/model 即重推
    // agent:start），是水平越权。web 侧编辑/删除本就按 ownedByMe 门控，服务端滞后。
    const existingDuty = await app.pg.query<{ duty: string }>("SELECT duty FROM agents WHERE id = $1", [agentId]);
    const wasOff = parseAgentDuty(existingDuty.rows[0]?.duty) === "off";
    const { name, displayName, description, avatarUrl, runtime, model } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (name !== undefined) {
      sets.push(`name = $${p++}`);
      params.push(name);
    }
    if (displayName !== undefined) {
      sets.push(`display_name = $${p++}`);
      params.push(displayName);
    }
    if (description !== undefined) {
      sets.push(`description = $${p++}`);
      params.push(description);
    }
    if (avatarUrl !== undefined) {
      sets.push(`avatar_url = $${p++}`);
      params.push(avatarUrl);
    }
    if (runtime !== undefined || model !== undefined) {
      sets.push(`runtime_profile = $${p++}::jsonb`);
      params.push(sql.json({ runtime: runtime || "claude", model: model || "sonnet" }));
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    const r = await app.pg.query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`, params);
    if (r.rows.length === 0) return reply.status(404).send({ error: "agent not found" });

    const agent = r.rows[0] as any;
    const rp = parseRuntimeProfile(agent.runtime_profile);
    // 停班中禁止 agent:start，否则会把人重新注册进 daemon
    if (!wasOff && parseAgentDuty(agent.duty) !== "off") {
      sendToDaemon(String(agent.user_id), {
        type: "agent:start",
        agentId: agent.id,
        config: {
          name: agent.name,
          displayName: agent.display_name,
          description: agent.description,
          runtime: rp.runtime,
          model: rp.model,
        },
      });
    }
    return { agent: { ...decorateAgentPresence(agent), runtime_profile: rp, runtime: rp.runtime, model: rp.model } };
  });

  // DELETE /agents/:agentId — 删除（连带频道成员关系；保留历史消息）
  app.delete("/agents/:agentId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req: any) => {
    const { agentId } = req.params;
    // P0.11：requireOwnAgent 已保证 agent 存在且属于调用者，sendToDaemon 目标即调用者本人。
    await app.pg.query("DELETE FROM channel_members WHERE member_id = $1 AND member_type = 'agent'", [agentId]);
    await app.pg.query("DELETE FROM agents WHERE id = $1", [agentId]);
    sendToDaemon(String(req.user.sub), { type: "agent:stop", agentId });
    return { ok: true };
  });

  // GET /agents/:agentId/workspace?path=MEMORY.md — owner 读本机工作区（daemon 白名单）
  app.get(
    "/agents/:agentId/workspace",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req: any, reply: any) => {
      const { agentId } = req.params as { agentId: string };
      const path = typeof req.query?.path === "string" ? req.query.path : undefined;
      const agent = await app.pg.query<{ name: string; user_id: string }>(
        "SELECT name, user_id FROM agents WHERE id = $1",
        [agentId],
      );
      if (agent.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
      const row = agent.rows[0]!;
      if (!daemonMeta.get(String(row.user_id))) {
        return reply.status(503).send({ error: "computer offline", exists: false, files: [] });
      }
      const result = await requestDaemonWorkspace(String(row.user_id), row.name, path);
      if (!result) return reply.status(504).send({ error: "workspace timeout", exists: false, files: [] });
      if (result.error && result.error !== "not found") {
        const status = result.error === "path not allowed" ? 400 : result.error === "file too large" ? 413 : 404;
        return reply.status(status).send({
          error: result.error,
          exists: result.exists,
          files: result.files || [],
          path: result.path,
        });
      }
      return {
        exists: result.exists,
        files: result.files || [],
        path: result.path,
        content: result.content,
        bytes: result.bytes,
      };
    },
  );
}
