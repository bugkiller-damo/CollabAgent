import type { FastifyInstance } from "fastify";

let cachedDefaultServerId: string | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60_000;

export async function getDefaultServerId(app: FastifyInstance): Promise<string | null> {
  if (cachedDefaultServerId && Date.now() < cacheExpiresAt) return cachedDefaultServerId;
  const shared = await app.pg.query<{ id: string }>(
    "SELECT id FROM servers WHERE personal = false ORDER BY created_at ASC LIMIT 1",
  );
  let id = shared.rows[0]?.id ?? null;
  if (!id) {
    const r = await app.pg.query<{ id: string }>("SELECT id FROM servers ORDER BY created_at ASC LIMIT 1");
    id = r.rows[0]?.id ?? null;
  }
  cachedDefaultServerId = id ? String(id) : null;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedDefaultServerId;
}

export function clearDefaultServerCache(): void {
  cachedDefaultServerId = null;
  cacheExpiresAt = 0;
}
