import postgres from "postgres";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "./migrate.js";
import { config } from "../lib/config.js";

const sql = postgres(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  idle_timeout: 30,
  max_lifetime: 60 * 30,
});

export { sql };

export default fp(async function pgPlugin(app: FastifyInstance) {
  await runMigrations();
  app.decorate("pg", {
    query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
      const result = await sql.unsafe(text, params as any[]);
      if (Array.isArray(result)) return { rows: result as unknown as T[] };
      return { rows: [result] as unknown as T[] };
    },
    // 事务：fn 拿到与 app.pg.query 同形的 tx 客户端，任一语句抛错即整体回滚。
    transaction: async <T = unknown>(fn: (tx: { query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[] }> }) => Promise<T>): Promise<T> => {
      return sql.begin(async (txSql) => {
        const txQuery = async <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
          const result = await txSql.unsafe(text, params as any[]);
          if (Array.isArray(result)) return { rows: result as unknown as R[] };
          return { rows: [result] as unknown as R[] };
        };
        return fn({ query: txQuery });
      }) as unknown as T;
    },
  });
});

export async function closeDb() {
  await sql.end();
}
