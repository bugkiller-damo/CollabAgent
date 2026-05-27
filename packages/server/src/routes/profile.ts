import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

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

  app.post("/change-password", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { oldPassword, newPassword } = req.body as any;
    if (!newPassword || newPassword.length < 6) {
      return reply.status(400).send({ error: "新密码至少 6 位" });
    }
    const result = await app.pg.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [(req as any).user.sub]
    );
    const user = result.rows[0] as any;
    if (!user || !(await bcrypt.compare(oldPassword, user.password_hash))) {
      return reply.status(401).send({ error: "当前密码错误" });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await app.pg.query(
      "UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1, updated_at = now() WHERE id = $2",
      [hash, (req as any).user.sub]
    );
    return { ok: true };
  });
}
