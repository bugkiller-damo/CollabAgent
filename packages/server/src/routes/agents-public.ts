import { BRIDGE_RUNTIME_IDS, parseAgentDuty, WIRED_RUNTIME_IDS } from "@collabagent/shared";
import type { FastifyInstance } from "fastify";
import { sql } from "../db/connection.js";
import { computerOnlineFor, decorateAgentPresence, setAgentDuty } from "../lib/agent-duty.js";
import { requireOwnAgent } from "../lib/agent-helpers.js";
import { getUserOrgIds, isOrgOwner } from "../lib/orgs.js";
import { isMachineOnline } from "../lib/presence.js";
import { broadcastProfileUpdate } from "../lib/profile-events.js";
import {
  agentMachineOnline,
  daemonTargetForAgent,
  findDaemonMeta,
  requestDaemonWorkspace,
  sendToAgentDaemon,
  sendToDaemon,
} from "../ws/handler.js";

/**
 * runtime_profile 可能是正确的 jsonb 对象，也可能是历史遗留的「双重编码字符串」，统一解析。
 */
function parseRuntimeProfile(v: unknown): { runtime?: string; model?: string; entrypoint?: string } {
  if (!v) return {};
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v as { runtime?: string; model?: string; entrypoint?: string };
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
      computer_machine_uuid: string | null;
    }>(
      // 计算机解析二级：① agents.computer_id 精确命中（绑定机）② NULL 兜底取属主在
      // 同 server 的任一机器行（存量数据展示）。多机时 ② 只用于展示，派发走绑定键。
      `SELECT a.id, a.user_id, a.name, a.display_name, a.description, a.avatar_url, a.status, a.duty,
              a.runtime_profile, a.server_id, a.created_at,
              c.id AS computer_id, c.name AS computer_name, c.hostname AS computer_hostname,
              c.machine_uuid AS computer_machine_uuid
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT c.id, c.name, c.hostname, c.machine_uuid
             FROM computers c
            WHERE c.id = a.computer_id
               OR (a.computer_id IS NULL AND c.user_id = a.user_id AND c.server_id = a.server_id)
            ORDER BY (c.id = a.computer_id) DESC, c.last_ready_at DESC NULLS LAST
            LIMIT 1
         ) c ON true
        WHERE a.server_id::text = ANY($1)${filter}
        ORDER BY a.created_at DESC`,
      params,
    );
    return {
      agents: agents.rows.map((a) => {
        const rp = parseRuntimeProfile(a.runtime_profile);
        const decorated = decorateAgentPresence(a);
        const computerOnline = a.computer_machine_uuid
          ? isMachineOnline(String(a.user_id), a.computer_machine_uuid, String(a.server_id))
          : computerOnlineFor(String(a.user_id));
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
                online: computerOnline,
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
    const { name, displayName, description, avatarUrl, runtime, model, entrypoint, serverId, computerId } = req.body;
    if (!name) return reply.status(400).send({ error: "name required" });

    // serverId 显式必填（2026-09-19 取消个人空间兜底后与 computers 端点同口径）；
    // 必须是创建者所 owner 的组织——member 只能参与频道，不可向 server 添加 agent
    if (!serverId) return reply.status(400).send({ error: "serverId required" });
    if (!(await isOrgOwner(app, String(serverId), req.user.sub)))
      return reply.status(403).send({ error: "only org owner can add agents" });
    const orgId = String(serverId);

    const runtimeId = String(runtime || "claude");
    if (!(WIRED_RUNTIME_IDS as readonly string[]).includes(runtimeId)) {
      return reply.status(400).send({ error: "runtime not wired", runtime: runtimeId });
    }
    // Phase 1：entrypoint 只对 bridge runtime（manifest 驱动）有意义；
    // claude 携带 entrypoint 是静态无效组合，fail-fast 而不是落库后由 daemon 死信。
    if (entrypoint !== undefined && entrypoint !== null && String(entrypoint).trim()) {
      if (!(BRIDGE_RUNTIME_IDS as readonly string[]).includes(runtimeId)) {
        return reply.status(400).send({ error: "entrypoint not allowed for runtime", runtime: runtimeId });
      }
    }

    // 2026-09-19 server-scoped computers：目标 server 必须有我的计算机行（已注册，
    // 不强求在线）。单机自动绑定；多机须显式 computerId；绑定行必须同 (user,server)。
    const machines = await app.pg.query<{ id: string; machine_uuid: string; name: string; hostname: string | null }>(
      `SELECT id, machine_uuid, name, hostname FROM computers
        WHERE user_id::text = $1 AND server_id = $2
        ORDER BY last_ready_at DESC NULLS LAST, created_at ASC`,
      [req.user.sub, orgId],
    );
    if (machines.rows.length === 0) {
      return reply.status(400).send({
        error: "register a computer in this server first (run the daemon with a token scoped to this server)",
        code: "no_computer_in_server",
      });
    }
    let bound: (typeof machines.rows)[number] | undefined;
    if (computerId) {
      bound = machines.rows.find((m) => String(m.id) === String(computerId));
      if (!bound) {
        return reply.status(400).send({
          error: "computerId does not match any of your computers registered in this server",
          candidates: machines.rows.map((m) => ({ id: m.id, name: m.name, hostname: m.hostname })),
        });
      }
    } else if (machines.rows.length === 1) {
      bound = machines.rows[0];
    } else {
      return reply.status(400).send({
        error: "multiple computers registered in this server — computerId required",
        code: "computer_required",
        candidates: machines.rows.map((m) => ({ id: m.id, name: m.name, hostname: m.hostname })),
      });
    }

    // runtime 探测用绑定机的 meta（该机的连接须同 scope 才算归属——metaForRow 同口径内联）
    const boundKey = `${req.user.sub}:${bound.machine_uuid}`;
    const meta = (() => {
      const m = findDaemonMeta(boundKey);
      return m && (!m.serverId || m.serverId === orgId) ? m : undefined;
    })();
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
      "INSERT INTO agents (user_id, server_id, computer_id, name, display_name, description, avatar_url, runtime_profile) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *",
      [
        req.user.sub,
        orgId,
        bound.id,
        name,
        displayName || name,
        description || "",
        avatarUrl || null,
        sql.json({
          runtime: runtimeId,
          model: model || "sonnet",
          // Phase 1：bridge runtime 的本机 manifest 入口 ID（非命令/路径）；
          // claude 等无 entrypoint 的 runtime 不落该键。
          ...(typeof entrypoint === "string" && entrypoint.trim() ? { entrypoint: entrypoint.trim() } : {}),
        }),
      ],
    );
    const agent = result.rows[0] as any;

    // Auto-start: notify this agent's owning daemon to spawn it（不广播——见 agents.ts
    // 对应 call site 的注释：广播会让别的 daemon 误注册这个 agent，hasAgent() 谎报，
    // 真正 @/派发时在 spawn 阶段 403 "not your agent"）。投递精确到绑定机的 machineKey。
    sendToDaemon(
      boundKey,
      {
        type: "agent:start",
        agent: {
          id: agent.id,
          name: agent.name,
          displayName: agent.display_name,
          runtime: runtimeId,
          model: model || "sonnet",
          ...(typeof entrypoint === "string" && entrypoint.trim() ? { entrypoint: entrypoint.trim() } : {}),
        },
        config: { runtime_profile: agent.runtime_profile },
      },
      { scope: orgId },
    );

    return { agent };
  });

  // PATCH /agents/:agentId — 编辑（资料 + 运行时）
  app.patch("/agents/:agentId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req: any, reply: any) => {
    const { agentId } = req.params;
    // P0.11：所有权校验收敛到 requireOwnAgent（与 /internal/agent 侧对齐）。此前只有
    // org 成员校验——共享 org 内任何成员都能改他人 agent（改 runtime/model 即重推
    // agent:start），是水平越权。web 侧编辑/删除本就按 ownedByMe 门控，服务端滞后。
    const existing = await app.pg.query<{ duty: string; runtime_profile: unknown }>(
      "SELECT duty, runtime_profile FROM agents WHERE id = $1",
      [agentId],
    );
    const wasOff = parseAgentDuty(existing.rows[0]?.duty) === "off";
    const {
      name,
      displayName,
      description,
      avatarUrl,
      runtime,
      model,
      entrypoint,
      allowTerminalWatch,
      consentChannelInvite,
    } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (allowTerminalWatch !== undefined) {
      if (typeof allowTerminalWatch !== "boolean") {
        return reply.status(400).send({ error: "allowTerminalWatch must be boolean" });
      }
      sets.push(`allow_terminal_watch = $${p++}`);
      params.push(allowTerminalWatch);
    }
    if (consentChannelInvite !== undefined) {
      if (typeof consentChannelInvite !== "boolean") {
        return reply.status(400).send({ error: "consentChannelInvite must be boolean" });
      }
      sets.push(`consent_channel_invite = $${p++}`);
      params.push(consentChannelInvite);
    }
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
    if (runtime !== undefined || model !== undefined || entrypoint !== undefined) {
      // Phase 1：runtime_profile 整体重写时保留未提及的键——只改 model 不能抹掉
      // 已存的 entrypoint；entrypoint: null/"" 视为显式清除。
      const prevRp = parseRuntimeProfile(existing.rows[0]?.runtime_profile);
      const nextEntrypoint =
        entrypoint === undefined
          ? prevRp.entrypoint
          : typeof entrypoint === "string" && entrypoint.trim()
            ? entrypoint.trim()
            : undefined;
      const nextRuntime = runtime || prevRp.runtime || "claude";
      // 与 POST 同一规则：claude 等无 entrypoint 的 runtime 不得携带/残留该键
      if (nextEntrypoint && !(BRIDGE_RUNTIME_IDS as readonly string[]).includes(nextRuntime)) {
        return reply.status(400).send({ error: "entrypoint not allowed for runtime", runtime: nextRuntime });
      }
      sets.push(`runtime_profile = $${p++}::jsonb`);
      params.push(
        sql.json({
          runtime: runtime || prevRp.runtime || "claude",
          model: model || prevRp.model || "sonnet",
          ...(nextEntrypoint ? { entrypoint: nextEntrypoint } : {}),
        }),
      );
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    const r = await app.pg.query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`, params);
    if (r.rows.length === 0) return reply.status(404).send({ error: "agent not found" });

    const agent = r.rows[0] as any;
    const rp = parseRuntimeProfile(agent.runtime_profile);
    // 资料字段变更 → 广播 profile:update（频道成员缓存就地回写，头像/显示名不落刷新）。
    // 仅 runtime/consent 等开关类 PATCH 不广播——成员缓存里没有这些字段的镜像。
    if (name !== undefined || displayName !== undefined || avatarUrl !== undefined) {
      await broadcastProfileUpdate(app.pg, {
        memberType: "agent",
        memberId: String(agent.id),
        handle: agent.name,
        displayName: agent.display_name || "",
        avatarUrl: agent.avatar_url ?? null,
        ownerUserId: String(agent.user_id),
        serverId: agent.server_id ? String(agent.server_id) : null,
      });
    }
    // 停班中禁止 agent:start，否则会把人重新注册进 daemon
    if (!wasOff && parseAgentDuty(agent.duty) !== "off") {
      await sendToAgentDaemon(app.pg, agent, {
        type: "agent:start",
        agentId: agent.id,
        config: {
          name: agent.name,
          displayName: agent.display_name,
          description: agent.description,
          runtime: rp.runtime,
          model: rp.model,
          ...(rp.entrypoint ? { entrypoint: rp.entrypoint } : {}),
        },
      });
    }
    return { agent: { ...decorateAgentPresence(agent), runtime_profile: rp, runtime: rp.runtime, model: rp.model } };
  });

  // DELETE /agents/:agentId — 删除（连带频道成员关系；保留历史消息）
  app.delete("/agents/:agentId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req: any, reply: any) => {
    const { agentId } = req.params;
    // P0.11：requireOwnAgent 已保证 agent 存在且属于调用者。绑定信息先取出——
    // 行删后 computer_id 随之消失，stop 事件的投递目标要靠它解析。
    const row = await app.pg.query<{ user_id: string; server_id: string; computer_id: string | null }>(
      "SELECT user_id, server_id, computer_id FROM agents WHERE id = $1",
      [agentId],
    );
    const agent = row.rows[0];
    // agent_credentials / agent_logins / dispatches 对 agents 均无 ON DELETE
    // CASCADE——与 orgs.ts 删服级联、test helpers 同口径显式删，缺一即 23503；
    // agent_cost_daily 随 FK CASCADE；历史消息（sender_id 多态无 FK）按口径保留。
    let removed: { channel_id: string }[];
    try {
      removed = await app.pg.transaction(async (tx) => {
        await tx.query("DELETE FROM agent_credentials WHERE agent_id = $1", [agentId]);
        await tx.query("DELETE FROM agent_logins WHERE agent_id = $1", [agentId]);
        await tx.query("DELETE FROM dispatches WHERE from_agent_id = $1 OR to_agent_id = $1", [agentId]);
        const r = await tx.query<{ channel_id: string }>(
          "DELETE FROM channel_members WHERE member_id = $1 AND member_type = 'agent' RETURNING channel_id",
          [agentId],
        );
        await tx.query("DELETE FROM agents WHERE id = $1", [agentId]);
        return r.rows;
      });
    } catch (e) {
      // 残余竞态窗（删 credentials 后、删 agents 前 daemon 重新签发/dispatch 插入）
      // → FK 23503 → 409 让客户端重试；此刻事务已回滚，agent 原样保留
      if ((e as { code?: string })?.code === "23503")
        return reply.status(409).send({ error: "agent busy, please retry" });
      throw e;
    }
    if (removed.length > 0) {
      const { invalidateMember } = await import("../lib/access.js");
      for (const r of removed) invalidateMember(String(r.channel_id), String(agentId));
    }
    if (agent) await sendToAgentDaemon(app.pg, agent, { type: "agent:stop", agentId });
    return { ok: true };
  });

  // GET /agents/:agentId/workspace?path=MEMORY.md — owner 读本机工作区（daemon 白名单）
  app.get(
    "/agents/:agentId/workspace",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req: any, reply: any) => {
      const { agentId } = req.params as { agentId: string };
      const path = typeof req.query?.path === "string" ? req.query.path : undefined;
      const agent = await app.pg.query<{
        name: string;
        user_id: string;
        server_id: string;
        computer_id: string | null;
      }>("SELECT name, user_id, server_id, computer_id FROM agents WHERE id = $1", [agentId]);
      if (agent.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
      const row = agent.rows[0]!;
      // 工作区在绑定机上——在线判定与请求目标都按绑定机解析（连接须在 agent scope）
      if (!(await agentMachineOnline(app.pg, row))) {
        return reply.status(503).send({ error: "computer offline", exists: false, files: [] });
      }
      const target = await daemonTargetForAgent(app.pg, row);
      const result = await requestDaemonWorkspace(target, row.name, path, 4000, { scope: String(row.server_id) });
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
