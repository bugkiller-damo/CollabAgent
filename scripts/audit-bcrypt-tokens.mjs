#!/usr/bin/env node
/**
 * O8：审计历史 bcrypt 令牌存量——判定 WS/HTTP 认证的 bcrypt 兼容分支能否退役。
 *
 * 用法：node scripts/audit-bcrypt-tokens.mjs
 * 或：  pnpm audit:bcrypt-tokens
 *
 * 输出 machine_tokens / agent_credentials 按哈希类型（bcrypt vs sha256）与状态
 * （active/expired/revoked）的计数，并给出退役判定。
 * 判定条件：两张表 active（未吊销且未过期）的 bcrypt 令牌数均为 0。
 * 哈希前缀口径与 packages/server/src/lib/token-hash.ts 的 isBcryptHash 一致
 * （$2a$ / $2b$ / $2y$）。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// DATABASE_URL：环境变量优先，其次 packages/server/.env
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  const envFile = resolve(__dirname, "../packages/server/.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
      if (m) {
        databaseUrl = m[1].replace(/^["']|["']$/g, "");
        break;
      }
    }
  }
}
if (!databaseUrl) {
  console.error("❌ DATABASE_URL 未设置（环境变量或 packages/server/.env）");
  process.exit(1);
}

// 从 server 包解析 postgres 依赖（脚本在仓库根，node_modules 结构不保证直连）
const require = createRequire(resolve(__dirname, "../packages/server/package.json"));
const pgModule = require("postgres");
const postgres = pgModule.default ?? pgModule;

const sql = postgres(databaseUrl);

const BCRYPT_PREFIXES = "token_hash LIKE '$2a$%' OR token_hash LIKE '$2b$%' OR token_hash LIKE '$2y$%'";

try {
  const rows = await sql.unsafe(`
    SELECT 'machine_tokens' AS table_name,
           CASE WHEN ${BCRYPT_PREFIXES} THEN 'bcrypt' ELSE 'sha256' END AS hash_kind,
           CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
                ELSE 'active' END AS status,
           count(*)::int AS count
      FROM machine_tokens
     GROUP BY 1, 2, 3
     UNION ALL
    SELECT 'agent_credentials',
           CASE WHEN ${BCRYPT_PREFIXES} THEN 'bcrypt' ELSE 'sha256' END,
           CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
                ELSE 'active' END,
           count(*)::int
      FROM agent_credentials
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3;
  `);

  console.log("┌─ bcrypt 令牌存量审计（O8 退役判定）");
  console.log("│ 表                | 哈希      | 状态     | 数量");
  for (const r of rows) {
    console.log(`│ ${r.table_name.padEnd(17)} | ${r.hash_kind.padEnd(9)} | ${r.status.padEnd(8)} | ${r.count}`);
  }

  const activeBcrypt = rows.filter((r) => r.hash_kind === "bcrypt" && r.status === "active");
  const totalBcrypt = rows.filter((r) => r.hash_kind === "bcrypt").reduce((s, r) => s + Number(r.count), 0);

  console.log("");
  if (activeBcrypt.length === 0) {
    console.log("✅ 退役判定：无 active 的 bcrypt 令牌，WS/HTTP 认证的 bcrypt 兼容分支可以删除。");
    console.log("   删除清单见 docs/2026-08-16/08-bcrypt-token-retirement.md（index.ts + ws/handler.ts 两处）。");
  } else {
    const total = activeBcrypt.reduce((s, r) => s + Number(r.count), 0);
    const detail = activeBcrypt.map((r) => `${r.table_name}:${r.count}`).join("，");
    console.log(`⚠️ 退役判定：仍有 ${total} 个 active bcrypt 令牌（${detail}），需先轮换/吊销后再退役。`);
  }
  if (totalBcrypt > 0) {
    console.log(`   历史 bcrypt 令牌总数（含过期/已吊销）：${totalBcrypt}。`);
    console.log(
      `   检查 SQL（active 口径）：SELECT count(*) FROM machine_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND (${BCRYPT_PREFIXES});`,
    );
  }
} finally {
  await sql.end();
}
