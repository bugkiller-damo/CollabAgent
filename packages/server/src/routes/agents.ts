import type { FastifyInstance } from "fastify";
import { daemonClients, broadcastToDaemons } from "../ws/handler.js";

export async function agentRoutes(app: FastifyInstance) {
  // List all agents with online status
  app.get("/", async () => {
    const result = await app.pg.query(
      "SELECT id, name, display_name, description, status, runtime, model, created_at FROM agents ORDER BY created_at DESC"
    );
    const agents = (result.rows as any[]).map((a) => ({
      ...a,
      isOnline: daemonClients.has(a.id),
    }));
    return { agents };
  });

  // List agents in a channel
  app.get("/channel/:channelId", async (req) => {
    const { channelId } = req.params as Record<string, string>;
    const result = await app.pg.query(
      "SELECT a.id, a.name, a.display_name, a.description, a.status, a.runtime, a.model, cm.role FROM agents a JOIN channel_members cm ON cm.member_id = a.id AND cm.member_type = 'agent' WHERE cm.channel_id = $1",
      [channelId]
    );
    const agents = (result.rows as any[]).map((a) => ({
      ...a,
      isOnline: daemonClients.has(a.id),
    }));
    return { agents };
  });

  // Create agent (via action card approval)
  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { name, displayName, description, runtime, model, serverId } = req.body as Record<string, unknown>;
    if (!name || !serverId) return reply.status(400).send({ error: "name and serverId required" });
    const userId = (req as any).user.sub;
    const result = await app.pg.query(
      "INSERT INTO agents (user_id, server_id, name, display_name, description, runtime, model) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [userId, serverId as string, name as string, (displayName || name) as string, description || "", runtime || "claude", model || "sonnet"]
    );
    const agent = result.rows[0];
    // Notify all daemons to spawn this agent
    broadcastToDaemons({
      type: "agent:start",
      agentId: agent.id,
      config: {
        name: agent.name,
        displayName: agent.display_name,
        runtime: agent.runtime,
        model: agent.model,
      },
    });
    return { agent };
  });

  // Update agent config
  app.patch("/:agentId", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { agentId } = req.params as Record<string, string>;
    const { status, runtime, model } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (status) { sets.push("status = $" + p++); params.push(status); }
    if (runtime) { sets.push("runtime = $" + p++); params.push(runtime); }
    if (model) { sets.push("model = $" + p++); params.push(model); }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
    params.push(agentId);
    await app.pg.query("UPDATE agents SET " + sets.join(", ") + " WHERE id = $" + p, params);
    return { ok: true };
  });
}
