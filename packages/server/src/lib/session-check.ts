/**
 * access token 会话状态校验（sid 未吊销 + token_version 未滚动）。
 *
 * 签发时 auth.ts 已把 sid/tv 签进 JWT，但 authenticate 原本只 jwt.verify，
 * 导致 logout-all / 改密 / 注销后旧 access token 在 7 天有效期内仍然可用。
 * 这里回查 DB，并用 5s TTL 缓存摊薄每请求一次的查询开销——旧 token 的
 * 有效窗口从「7 天」缩到「最多 5 秒」。
 *
 * P1.15：第一参数从 FastifyInstance 改为最小 pg 形状——HTTP 传 server.pg、
 * WS 传 wsPg 都能用（verifyBrowserToken 在 lib/auth-token.ts 里两侧共用）。
 */
const cache = new Map<string, { ok: boolean; expiresAt: number }>();
const TTL_MS = 5000;

/** 吊销类操作（logout / logout-all / 改密 / 注销）后调用，立即让旧 token 失效，不等 5s TTL。 */
export function clearSessionCache(): void {
  cache.clear();
}

export async function isSessionValid(
  pg: { query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  sid: string,
  userId: string,
  tv?: string,
): Promise<boolean> {
  const key = `${sid}:${tv ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.ok;

  let ok = false;
  try {
    const s = await pg.query("SELECT 1 FROM user_sessions WHERE id = $1 AND revoked_at IS NULL", [sid]);
    if (s.rows.length > 0) {
      if (tv) {
        const u = await pg.query("SELECT 1 FROM users WHERE id = $1 AND token_version = $2", [userId, tv]);
        ok = u.rows.length > 0;
      } else {
        ok = true;
      }
    }
  } catch {
    ok = false; // DB 异常时按无效处理，宁可误拒不可误放
  }

  cache.set(key, { ok, expiresAt: Date.now() + TTL_MS });
  return ok;
}
