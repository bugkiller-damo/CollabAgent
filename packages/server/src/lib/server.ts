import type { FastifyInstance } from "fastify";

let cachedDefaultServerId: string | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60_000;

// 默认社区 = 广场。2026-09-18 起判定升格为显式 is_public 列（最早 is_public
// server）；无命中回退最早 server（2026-09-19 personal 特例取消后原「非
// personal」子句恒真，化简）。
export async function getDefaultServerId(app: FastifyInstance): Promise<string | null> {
  if (cachedDefaultServerId && Date.now() < cacheExpiresAt) return cachedDefaultServerId;
  const shared = await app.pg.query<{ id: string }>(
    "SELECT id FROM servers WHERE is_public = true ORDER BY created_at ASC LIMIT 1",
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
