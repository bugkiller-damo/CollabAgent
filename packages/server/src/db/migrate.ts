import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "migrations");

// P0.10：迁移会话锁（固定 key，勿与审计链 712042 等其他 advisory lock 撞号）。
// 多实例并发启动、以及 index.ts 与 pgPlugin 双处触发 runMigrations 时串行化——
// 后到者等锁结束后读到的 _migrations 已是先到者的完整结果，自然全部 skip。
const MIGRATION_LOCK_KEY = 712_043;

export async function runMigrations(opts?: { dir?: string }): Promise<number> {
  const dir = opts?.dir ?? migrationsDir; // dir 注入仅供测试用 scratch 目录，生产勿传
  // pg_advisory_lock 是会话级锁：必须 sql.reserve() 独占一条连接，锁内所有语句
  // 走在同一会话上；连接归还/进程退出时锁自动释放（不留死锁），finally 里显式
  // unlock 让连接尽快回池。
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;

    // Ensure migrations tracking table exists
    await conn.unsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

    // Get already applied migrations
    const applied = new Set((await conn`SELECT name FROM _migrations`).map((r: any) => r.name));

    // Find and sort migration files
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      console.log(`[DB] Running migration: ${file}`);
      const content = readFileSync(join(dir, file), "utf-8");
      // P0.10：每文件一个事务——迁移内容与 _migrations 记录同生共死，中途失败
      // 整体回滚不留半态，修复文件后重跑即可从断点续上。
      // 注：postgres.js 的 ReservedSql 不支持 .begin()（保留连接只挂 unsafe/tagged
      // 等基础方法），故在独占会话上手动 BEGIN/COMMIT/ROLLBACK。
      await conn.unsafe("BEGIN");
      try {
        await conn.unsafe(content);
        await conn`INSERT INTO _migrations (name) VALUES (${file})`;
        await conn.unsafe("COMMIT");
      } catch (err) {
        await conn.unsafe("ROLLBACK").catch(() => {});
        throw err;
      }
      count++;
      console.log(`[DB] Migration applied: ${file}`);
    }

    if (count === 0) {
      console.log("[DB] All migrations up to date");
    } else {
      console.log(`[DB] ${count} migration(s) applied`);
    }
    return count;
  } finally {
    await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => {});
    conn.release();
  }
}

// 作为脚本直接运行时（pnpm db:migrate / CI）：执行迁移后退出
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(async () => {
      await sql.end();
      console.log("[DB] migrate done");
      process.exit(0);
    })
    .catch(async (e) => {
      console.error("[DB] migrate failed:", e);
      try {
        await sql.end();
      } catch {
        /* ignore */
      }
      process.exit(1);
    });
}
