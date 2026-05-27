import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const registerSchema = z.object({
  email: z.string().email(),
  handle: z.string().min(2).max(80),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, code: "INVALID_ARG", message: parsed.error.message });
    }
    const { email, handle, displayName, password } = parsed.data;

    // TODO: check duplicate, insert user
    const passwordHash = await bcrypt.hash(password, 10);
    // const user = await db.insert(users).values({ handle, displayName, passwordHash }).returning();

    const token = jwt.sign({ userId: "placeholder", handle }, JWT_SECRET, { expiresIn: "7d" });
    return { ok: true, data: { token, handle, displayName } };
  });

  app.post("/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, code: "INVALID_ARG", message: parsed.error.message });
    }
    const { email, password } = parsed.data;

    // TODO: find user, verify password
    // const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    // if (!user || !await bcrypt.compare(password, user.passwordHash)) {
    //   return reply.status(401).send({ ok: false, code: "AUTH_FAILED", message: "Invalid credentials" });
    // }

    const token = jwt.sign({ userId: "placeholder", handle: "demo" }, JWT_SECRET, { expiresIn: "7d" });
    return { ok: true, data: { token } };
  });
}
