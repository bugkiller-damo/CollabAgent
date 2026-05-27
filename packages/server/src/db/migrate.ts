import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "migrations");

export async function runMigrations() {
  // Ensure migrations tracking table exists
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Get already applied migrations
  const applied = new Set(
    (await sql`SELECT name FROM _migrations`).map((r: any) => r.name)
  );

  // Find and sort migration files
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[DB] Running migration: ${file}`);
    const content = readFileSync(join(migrationsDir, file), "utf-8");
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    count++;
    console.log(`[DB] Migration applied: ${file}`);
  }

  if (count === 0) {
    console.log("[DB] All migrations up to date");
  } else {
    console.log(`[DB] ${count} migration(s) applied`);
  }
}
