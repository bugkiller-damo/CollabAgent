import type { FastifyInstance } from "fastify";

// 「默认服务器」解析集中到这里，避免各处散落 `SELECT id FROM servers LIMIT 1`。
// 优先取共享的非个人服务器（personal=false，最早创建的那个）；没有再退回最早的任意服务器。
let cachedDefaultServerId: string | null = null;

export async function getDefaultServerId(app: FastifyInstance): Promise<string | null> {
  if (cachedDefaultServerId) return cachedDefaultServerId;
  const shared = await app.pg.query(
    "SELECT id FROM servers WHERE personal = false ORDER BY created_at ASC LIMIT 1"
  );
  let id = (shared.rows[0] as any)?.id ?? null;
  if (!id) {
    const any = await app.pg.query("SELECT id FROM servers ORDER BY created_at ASC LIMIT 1");
    id = (any.rows[0] as any)?.id ?? null;
  }
  cachedDefaultServerId = id ? String(id) : null;
  return cachedDefaultServerId;
}

// 测试或新建服务器后允许失效缓存
export function clearDefaultServerCache(): void {
  cachedDefaultServerId = null;
}
