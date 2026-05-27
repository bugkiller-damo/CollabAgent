import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

const sql = postgres(process.env.DATABASE_URL || "postgresql://postgres:P@ssw0rd@localhost:5432/collabagent");

const schemaPath = join(__dirname, "schema.sql");
const schema = readFileSync(schemaPath, "utf-8");

console.log("Running schema migration...");
await sql.unsafe(schema);
console.log("Schema migration complete.");

await sql.end();
