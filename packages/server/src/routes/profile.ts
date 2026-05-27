import type { FastifyInstance } from "fastify";

export async function profileRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req) => {
    const { target } = req.query as any;
    const id = target || (req as any).user.sub;
    const result = await app.pg.query(
      "SELECT id, handle, display_name, description, avatar_url, created_at FROM users WHERE handle = $1 OR id = $2",
      [target, id]
    );
    if (result.rows.length === 0) return { error: "not found" };
    return result.rows[0];
  });

  app.post("/", { preHandler: [app.authenticate] }, async (req) => {
    const { displayName, description } = req.body as any;
    await app.pg.query(
      `UPDATE users SET display_name = COALESCE($2, display_name),
       description = COALESCE($3, description), updated_at = now() WHERE id = $1`,
      [(req as any).user.sub, displayName, description]
    );
    return { ok: true };
  });
}
