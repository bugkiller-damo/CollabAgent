import postgres from "postgres";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "./migrate.js";

const sql = postgres(process.env.DATABASE_URL || "postgresql://postgres:P@ssw0rd@localhost:5432/collabagent");

export { sql };

export default fp(async function pgPlugin(app: FastifyInstance) {
  await runMigrations();
  app.decorate("pg", {
    query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
      const result = await sql.unsafe(text, params as any[]);
      if (Array.isArray(result)) return { rows: result as T[] };
      return { rows: [result] as T[] };
    },
  });
});

export async function closeDb() {
  await sql.end();
}
