import postgres from "postgres";
import bcrypt from "bcryptjs";

const sql = postgres(process.env.DATABASE_URL || "postgresql://postgres:P@ssw0rd@localhost:5432/collabagent");

console.log("Seeding database...");

// Create a demo user
const passwordHash = bcrypt.hashSync("password123", 10);
const [user] = await sql`
  INSERT INTO users (handle, display_name, password_hash)
  VALUES ('demo', 'Demo User', ${passwordHash})
  ON CONFLICT (handle) DO UPDATE SET display_name = 'Demo User'
  RETURNING id
`;
console.log("Demo user created:", user.id);

// Create a default server
const [server] = await sql`
  INSERT INTO servers (name, created_by)
  VALUES ('Default Server', ${user.id})
  ON CONFLICT DO NOTHING
  RETURNING id
`;
const serverId = server?.id;
if (!serverId) {
  const [existing] = await sql`SELECT id FROM servers WHERE name = 'Default Server'`;
  console.log("Server already exists:", existing?.id);
} else {
  console.log("Server created:", serverId);
}

// Create default channels
const resolvedServerId = serverId || (await sql`SELECT id FROM servers WHERE name = 'Default Server'`)[0]?.id;

for (const ch of ["general", "random", "engineering"]) {
  await sql`
    INSERT INTO channels (server_id, name, description)
    VALUES (${resolvedServerId}, ${ch}, ${ch === "general" ? "General discussion" : ch === "random" ? "Random topics" : "Engineering team"})
    ON CONFLICT DO NOTHING
  `;
  console.log(`Channel #${ch} created`);
}

console.log("Seed complete.");
await sql.end();
