import type { FastifyInstance } from "fastify";
import { daemonClients, broadcastToDaemons } from "../ws/handler.js";
import { getAgent } from "../lib/agent-helpers.js";
import { agentMessageRoutes } from "./agents-messages.js";
import { agentTaskRoutes } from "./agents-tasks.js";
import { agentReminderRoutes } from "./agents-reminders.js";

export async function agentRoutes(app: FastifyInstance) {
  // List all agents with online status
  app.get("/", async () => {
    const result = await app.pg.query<{ id: string; user_id: string; name: string; display_name: string; description: string; avatar_url: string; status: string; runtime_profile: unknown; created_at: string }>(
      "SELECT id, user_id, name, display_name, description, avatar_url, status, runtime_profile, created_at FROM agents ORDER BY created_at DESC"
    );
    return { agents: result.rows.map((a) => ({ ...a, isOnline: daemonClients.has(String(a.user_id)) })) };
  });

  // List agents in a channel
  app.get("/channel/:channelId", async (req) => {
    const { channelId } = req.params as Record<string, string>;
    const result = await app.pg.query<{ id: string; user_id: string; name: string; display_name: string; description: string; avatar_url: string; status: string; runtime_profile: unknown; role: string }>(
      "SELECT a.id, a.user_id, a.name, a.display_name, a.description, a.avatar_url, a.status, a.runtime_profile, cm.role FROM agents a JOIN channel_members cm ON cm.member_id = a.id AND cm.member_type = 'agent' WHERE cm.channel_id = $1",
      [channelId]
    );
    return { agents: result.rows.map((a) => ({ ...a, isOnline: daemonClients.has(String(a.user_id)) })) };
  });

  // Create agent
  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { name, displayName, description, runtime, model, serverId } = req.body as Record<string, unknown>;
    if (!name || !serverId) return reply.status(400).send({ error: "name and serverId required" });
    const userId = req.user.sub;
    const result = await app.pg.query(
      "INSERT INTO agents (user_id, server_id, name, display_name, description, runtime, model) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [userId, serverId as string, name as string, (displayName || name) as string, description || "", runtime || "claude", model || "sonnet"]
    );
    const agent = result.rows[0];
    broadcastToDaemons({ type: "agent:start", agentId: agent.id, config: { name: agent.name, displayName: agent.display_name, description: agent.description, runtime: agent.runtime, model: agent.model } });
    return { agent };
  });

  // Profile (self or others)
  app.get("/:agentId/profile", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { target } = req.query as Record<string, string>;
    if (target) {
      const handle = target.replace(/^@/, "");
      const u = await app.pg.query("SELECT handle, display_name, description, avatar_url FROM users WHERE handle = $1", [handle]);
      if (u.rows.length) return { type: "human", ...u.rows[0] };
      const a = await app.pg.query("SELECT name as handle, display_name, description, avatar_url FROM agents WHERE name = $1", [handle]);
      if (a.rows.length) return { type: "agent", ...a.rows[0] };
      return reply.status(404).send({ error: "profile not found" });
    }
    const self = await app.pg.query("SELECT name as handle, display_name, description, avatar_url FROM agents WHERE id = $1", [agentId]);
    if (self.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    return { type: "agent", ...self.rows[0] };
  });

  // Update profile
  app.post("/:agentId/profile", { preHandler: [app.authenticate] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { displayName, description } = req.body as { displayName?: string; description?: string };
    const sets: string[] = []; const params: any[] = []; let p = 1;
    if (displayName !== undefined) { sets.push(`display_name = $${p++}`); params.push(displayName); }
    if (description !== undefined) { sets.push(`description = $${p++}`); params.push(description); }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    const r = await app.pg.query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${p} RETURNING name as handle, display_name, description`, params);
    if (r.rows.length === 0) return reply.status(404).send({ error: "agent not found" });
    return { type: "agent", ...r.rows[0] };
  });

  // Update runtime config
  app.patch("/:agentId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { agentId } = req.params as Record<string, string>;
    const { status, runtime, model } = req.body as Record<string, unknown>;
    const sets: string[] = []; const params: unknown[] = []; let p = 1;
    if (status) { sets.push("status = $" + p++); params.push(status); }
    if (runtime) { sets.push("runtime = $" + p++); params.push(runtime); }
    if (model) { sets.push("model = $" + p++); params.push(model); }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    await app.pg.query("UPDATE agents SET " + sets.join(", ") + " WHERE id = $" + p, params);
    return { ok: true };
  });
}
