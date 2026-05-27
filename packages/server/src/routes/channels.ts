import type { FastifyInstance } from "fastify";

export async function channelRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req) => {
    const { serverId } = req.query as any;
    const result = await app.pg.query(
      `SELECT c.*, cm.role
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1
       WHERE c.server_id = $2 AND c.archived = false
       ORDER BY c.created_at`,
      [(req as any).user.sub, serverId]
    );
    return { channels: result.rows };
  });

  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId, name, description, type } = req.body as any;
    if (!name) return reply.status(400).send({ error: "name required" });
    const result = await app.pg.query(
      `INSERT INTO channels (server_id, name, description, type, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [serverId, name, description || null, type || "public", (req as any).user.sub]
    );
    return { channel: result.rows[0] };
  });

  app.get("/:channelId/members", { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as any;
    const result = await app.pg.query(
      `SELECT cm.member_id, cm.member_type, cm.role, cm.joined_at,
              COALESCE(u.handle, a.name) as handle,
              COALESCE(u.display_name, a.display_name) as display_name
       FROM channel_members cm
       LEFT JOIN users u ON cm.member_type = 'human' AND cm.member_id = u.id
       LEFT JOIN agents a ON cm.member_type = 'agent' AND cm.member_id = a.id
       WHERE cm.channel_id = $1`,
      [channelId]
    );
    return { members: result.rows };
  });

  app.post("/:channelId/join", { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as any;
    const { memberType } = req.body as any;
    await app.pg.query(
      `INSERT INTO channel_members (channel_id, member_id, member_type)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [channelId, (req as any).user.sub, memberType || "human"]
    );
    return { ok: true };
  });

  app.post("/:channelId/leave", { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as any;
    await app.pg.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2`,
      [channelId, (req as any).user.sub]
    );
    return { ok: true };
  });

  app.get("/resolve", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target } = req.query as any;
    if (!target) return reply.status(400).send({ error: "target required" });
    if (target.startsWith("dm:@")) {
      const handle = target.slice(3);
      const result = await app.pg.query(
        "SELECT id, handle, display_name FROM users WHERE handle = $1", [handle]
      );
      if (result.rows.length === 0) return reply.status(404).send({ error: "user not found" });
      return { type: "dm", ...result.rows[0] };
    }
    const name = target.startsWith("#") ? target.slice(1).split(":")[0] : target;
    const result = await app.pg.query("SELECT * FROM channels WHERE name = $1", [name]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "channel not found" });
    return { type: "channel", ...result.rows[0] };
  });

  app.get("/server", { preHandler: [app.authenticate] }, async (req) => {
    const { serverId } = req.query as any;
    const [channels, agents, humans] = await Promise.all([
      app.pg.query(
        `SELECT c.*, cm.role
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = $1
         WHERE c.server_id = $2 AND c.archived = false`,
        [(req as any).user.sub, serverId]
      ),
      app.pg.query("SELECT * FROM agents WHERE server_id = $1", [serverId]),
      app.pg.query(
        `SELECT DISTINCT u.id, u.handle, u.display_name, u.avatar_url
         FROM users u
         JOIN channel_members cm ON cm.member_id = u.id AND cm.member_type = 'human'
         JOIN channels c ON c.id = cm.channel_id WHERE c.server_id = $1`,
        [serverId]
      ),
    ]);
    return { channels: channels.rows, agents: agents.rows, humans: humans.rows };
  });
}
