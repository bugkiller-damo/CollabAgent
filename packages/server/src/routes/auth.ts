import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", async (req, reply) => {
    const { handle, password, displayName } = req.body as Record<string, unknown>;
    if (!handle || !password || typeof handle !== "string" || typeof password !== "string") {
      return reply.status(400).send({ error: "handle and password required" });
    }
    const existing = await app.pg.query(
      "SELECT id FROM users WHERE lower(handle) = $1", [handle.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send({ error: "handle already taken" });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await app.pg.query(
      "INSERT INTO users (handle, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, handle, display_name, created_at",
      [handle, (displayName as string) || null, hash]
    );
    const user = result.rows[0];
    const token = app.jwt.sign({ sub: user.id, handle: user.handle });
    return { token, user };
  });

  app.post("/login", async (req, reply) => {
    const { handle, password } = req.body as Record<string, unknown>;
    if (typeof handle !== "string" || typeof password !== "string") {
      return reply.status(400).send({ error: "handle and password required" });
    }
    const result = await app.pg.query(
      "SELECT id, handle, display_name, password_hash FROM users WHERE lower(handle) = $1",
      [handle.toLowerCase()]
    );
    const user = result.rows[0] as Record<string, unknown> | undefined;
    if (!user || !(await bcrypt.compare(password, user.password_hash as string))) {
      return reply.status(401).send({ error: "invalid credentials" });
    }
    const token = app.jwt.sign({ sub: user.id, handle: user.handle });
    return { token, user: { id: user.id, handle: user.handle, displayName: user.display_name } };
  });
}
