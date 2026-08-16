import type { FastifyInstance } from "fastify";
import { getAgent, requireOwnAgent } from "../lib/agent-helpers.js";
import { daemonClients, sendToDaemon } from "../ws/handler.js";
import { agentMessageRoutes } from "./agents-messages.js";
import { agentReminderRoutes } from "./agents-reminders.js";
import { agentTaskRoutes } from "./agents-tasks.js";

export async function agentRoutes(app: FastifyInstance) {
  // List all agents with online status（需登录：agent 列表含归属 user_id，不宜公开）
  app.get("/", { preHandler: [app.authenticate] }, async () => {
    const result = await app.pg.query<{
      id: string;
      user_id: string;
      name: string;
      display_name: string;
      description: string;
      avatar_url: string;
      status: string;
      runtime_profile: unknown;
      created_at: string;
    }>(
      "SELECT id, user_id, name, display_name, description, avatar_url, status, runtime_profile, created_at FROM agents ORDER BY created_at DESC",
    );
    return { agents: result.rows.map((a) => ({ ...a, isOnline: daemonClients.has(String(a.user_id)) })) };
  });

  // List agents in a channel（需登录）
  app.get("/channel/:channelId", { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as Record<string, string>;
    const result = await app.pg.query<{
      id: string;
      user_id: string;
      name: string;
      display_name: string;
      description: string;
      avatar_url: string;
      status: string;
      runtime_profile: unknown;
      role: string;
    }>(
      "SELECT a.id, a.user_id, a.name, a.display_name, a.description, a.avatar_url, a.status, a.runtime_profile, cm.role FROM agents a JOIN channel_members cm ON cm.member_id = a.id AND cm.member_type = 'agent' WHERE cm.channel_id = $1",
      [channelId],
    );
    return { agents: result.rows.map((a) => ({ ...a, isOnline: daemonClients.has(String(a.user_id)) })) };
  });

  // Create agent
  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { name, displayName, description, runtime, model, serverId } = req.body as Record<string, unknown>;
    if (!name || !serverId) return reply.status(400).send({ error: "name and serverId required" });
    const userId = req.user.sub;
    const { sql } = await import("../db/connection.js");
    const result = await app.pg.query(
      "INSERT INTO agents (user_id, server_id, name, display_name, description, runtime_profile) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *",
      [
        userId,
        serverId as string,
        name as string,
        (displayName || name) as string,
        description || "",
        sql.json({ runtime: (runtime as string) || "claude", model: (model as string) || "sonnet" }),
      ],
    );
    const agent = result.rows[0] as any;
    const rp =
      (typeof agent.runtime_profile === "string" ? JSON.parse(agent.runtime_profile) : agent.runtime_profile) || {};
    // 只通知这个 agent 真正的所有者的 daemon——广播给所有 daemon 会导致别的 daemon
    // 也把这个 agent 注册进本地的 agentDrivers（hasAgent() 返回 true），但它们的
    // 账号级 apiKey 换不出这个 agent 的凭证，@ 提及/派发到它时会在 spawn 阶段
    // 403 "not your agent"。
    sendToDaemon(String(agent.user_id), {
      type: "agent:start",
      agentId: agent.id,
      config: {
        name: agent.name,
        displayName: agent.display_name,
        description: agent.description,
        runtime: rp.runtime || "claude",
        model: rp.model || "sonnet",
      },
    });
    return { agent };
  });

  // Agent 自主加入/退出公开频道（daemon CLI `slock join/leave` 调用的端点——
  // 此前路由缺失，CLI 调用返回 404 "Not Found"）。
  // 私有频道与人类侧 join 限制一致：必须由频道管理员通过 /api/channels/:id/invite 拉入。
  app.post(
    "/:agentId/channels/:channelName/join",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const { agentId, channelName } = req.params as Record<string, string>;
      const name = channelName.replace(/^#/, "").split(":")[0];
      const ch = await app.pg.query<{ id: string; type: string }>("SELECT id, type FROM channels WHERE name = $1", [
        name,
      ]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      if (ch.rows[0].type !== "public") {
        return reply.status(403).send({ error: "private channels require an invite from a channel admin" });
      }
      await app.pg.query(
        "INSERT INTO channel_members (channel_id, member_id, member_type, role) VALUES ($1, $2, 'agent', 'member') ON CONFLICT DO NOTHING",
        [ch.rows[0].id, agentId],
      );
      return { ok: true };
    },
  );

  app.post(
    "/:agentId/channels/:channelName/leave",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const { agentId, channelName } = req.params as Record<string, string>;
      const name = channelName.replace(/^#/, "").split(":")[0];
      const ch = await app.pg.query<{ id: string }>("SELECT id FROM channels WHERE name = $1", [name]);
      if (ch.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
      await app.pg.query(
        "DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent'",
        [ch.rows[0].id, agentId],
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

  // Update runtime config
  app.patch("/:agentId", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const { agentId } = req.params as Record<string, string>;
    const { status, runtime, model } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (status) {
      sets.push("status = $" + p++);
      params.push(status);
    }
    if (runtime) {
      sets.push("runtime = $" + p++);
      params.push(runtime);
    }
    if (model) {
      sets.push("model = $" + p++);
      params.push(model);
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    await app.pg.query("UPDATE agents SET " + sets.join(", ") + " WHERE id = $" + p, params);
    return { ok: true };
  });
}
