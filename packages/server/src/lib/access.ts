import type { FastifyInstance } from "fastify";

const cache = new Map<string, { value: any; expiresAt: number }>();
const TTL = 2000;

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const e = cache.get(key);
  if (e && Date.now() < e.expiresAt) return e.value as T;
  const v = await fn();
  cache.set(key, { value: v, expiresAt: Date.now() + TTL });
  return v;
}

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of cache) if (v.expiresAt < n) cache.delete(k);
}, 10_000);

export async function getChannelType(app: FastifyInstance, channelId: string): Promise<string | null> {
  return cached(`t:${channelId}`, async () => {
    const r = await app.pg.query<{ type: string }>("SELECT type FROM channels WHERE id = $1", [channelId]);
    return r.rows[0]?.type ?? null;
  });
}

export async function getMemberRole(app: FastifyInstance, channelId: string, userId: string): Promise<string | null> {
  return cached(`r:${channelId}:${userId}`, async () => {
    const r = await app.pg.query<{ role: string }>(
      "SELECT role FROM channel_members WHERE channel_id = $1 AND member_id::text = $2 AND member_type = 'human'",
      [channelId, userId],
    );
    return r.rows[0]?.role ?? null;
  });
}

export async function canAccessChannel(app: FastifyInstance, channelId: string, userId: string): Promise<boolean> {
  const type = await getChannelType(app, channelId);
  if (type === null) return false;
  if (type !== "private" && type !== "dm") return true;
  return (await getMemberRole(app, channelId, userId)) !== null;
}

export async function canManageChannel(app: FastifyInstance, channelId: string, userId: string): Promise<boolean> {
  const role = await getMemberRole(app, channelId, userId);
  return role === "owner" || role === "admin";
}
