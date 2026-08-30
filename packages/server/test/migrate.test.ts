import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, sql } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";

// P0.10 回归：迁移会话级 advisory lock（多实例并发启动串行化）+ 每文件事务（失败不留半态）。
// 用 scratch 目录 + zz_test_ 前缀假迁移在真实库上验证；beforeAll/afterAll 双向清理假记录与表。

async function cleanup() {
  await sql`DELETE FROM _migrations WHERE name LIKE 'zz_test_%'`;
  await sql`DROP TABLE IF EXISTS zz_test_migrate_a`;
  await sql`DROP TABLE IF EXISTS zz_test_migrate_b`;
  await sql`DROP TABLE IF EXISTS zz_test_migrate_c`;
}

beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe("migrate: advisory lock + 每文件事务（P0.10）", () => {
  it("并发执行串行化：同一 scratch 目录并发跑两遍，恰好应用一次且都成功", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slock-mig-"));
    writeFileSync(join(dir, "zz_test_900_a.sql"), "CREATE TABLE zz_test_migrate_a (id int PRIMARY KEY);");
    try {
      // 无锁时两遍会同时判定「未应用」→ 重复执行 CREATE TABLE / _migrations 主键冲突
      const [a, b] = await Promise.all([runMigrations({ dir }), runMigrations({ dir })]);
      expect(a + b).toBe(1);
      expect((await sql`SELECT name FROM _migrations WHERE name = 'zz_test_900_a.sql'`).length).toBe(1);
      expect((await sql`SELECT to_regclass('zz_test_migrate_a') AS t`)[0].t).toBe("zz_test_migrate_a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败迁移整体回滚：前序文件保留，坏文件不留半态，修复后可重入续跑", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slock-mig-"));
    writeFileSync(join(dir, "zz_test_901_b.sql"), "CREATE TABLE zz_test_migrate_b (id int);");
    writeFileSync(join(dir, "zz_test_902_c.sql"), "CREATE TABLE zz_test_migrate_c (id int);\nTHIS IS NOT VALID SQL;");
    try {
      await expect(runMigrations({ dir })).rejects.toThrow();
      // 901 已提交并记录（断点），902 整体回滚：表不存在、_migrations 无记录
      expect((await sql`SELECT name FROM _migrations WHERE name = 'zz_test_901_b.sql'`).length).toBe(1);
      expect((await sql`SELECT to_regclass('zz_test_migrate_b') AS t`)[0].t).toBe("zz_test_migrate_b");
      expect((await sql`SELECT to_regclass('zz_test_migrate_c') AS t`)[0].t).toBeNull();
      expect((await sql`SELECT name FROM _migrations WHERE name = 'zz_test_902_c.sql'`).length).toBe(0);
      // 修复坏文件后重入：只补应用 902 这一个文件
      writeFileSync(join(dir, "zz_test_902_c.sql"), "CREATE TABLE zz_test_migrate_c (id int);");
      await expect(runMigrations({ dir })).resolves.toBe(1);
      expect((await sql`SELECT to_regclass('zz_test_migrate_c') AS t`)[0].t).toBe("zz_test_migrate_c");
      expect((await sql`SELECT name FROM _migrations WHERE name = 'zz_test_902_c.sql'`).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("全部已应用时返回 0（真实目录 no-op 路径）", async () => {
    await expect(runMigrations()).resolves.toBe(0);
  });
});
