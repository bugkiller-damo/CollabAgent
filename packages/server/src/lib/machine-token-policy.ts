import type { FastifyInstance } from "fastify";

// 评估报告 P1.12：sk_machine_ 是账号级全权令牌，此前 expires_at 列自 000 建表
// 就存在但从未被写入（永不过期），且同一用户可无限签发。本文件集中承载三项
// 策略常量与判定，供签发（profile.ts / computers.ts）与校验（index.ts HTTP /
// ws/handler.ts WS）四处共用；P1.15 抽 lib/auth-token.ts 收敛校验时一并迁入。

/** 默认有效期（天）：新签发的 machine_token 一律 90 天 */
export const MACHINE_TOKEN_TTL_DAYS = 90;

/**
 * 滚动续期阈值（天）：HTTP 认证每请求都会走，剩余有效期低于该阈值才写库续期，
 * 把续期写放大压到「每令牌最多每 90−30=60 天一次」。WS 侧连接频率低，不做阈值
 * 门控（连接即续期）。
 */
export const MACHINE_TOKEN_RENEW_THRESHOLD_DAYS = 30;

/** 同一用户同时活跃（未吊销且未过期）的 machine_token 数量上限 */
export const MACHINE_TOKEN_MAX_ACTIVE_PER_USER = 10;

/**
 * 活跃令牌谓词：expires_at 为 NULL 的行豁免。019 迁移已把存量 NULL 回填为
 * 迁移时刻 +90 天，此后 NULL 只剩测试/手工直插的数据；校验侧保持对 NULL 宽松，
 * 避免历史行被误杀（bcrypt-token.test.ts 直插行为依赖此豁免）。
 */
export const ACTIVE_TOKEN_PREDICATE = "(expires_at IS NULL OR expires_at > now())";

/**
 * bcrypt 形态哈希谓词（P1.14）：legacy 兼容路径的全表扫描用 SQL 侧预过滤，
 * 只取 $2a$/$2b$/$2y$ 前缀的行——存量全部轮换为 sha256 后该查询稳定返回 0 行，
 * 兼容路径退化为一次廉价查询（与 08-bcrypt-token-retirement.md 的审计 SQL 同口径）。
 * JS 侧 isBcryptHash 校验保留作纵深防御。
 */
export const BCRYPT_TOKEN_PREDICATE = "(token_hash LIKE '$2a$%' OR token_hash LIKE '$2b$%' OR token_hash LIKE '$2y$%')";

/** 剩余有效期是否已进入续期窗口（NULL 表示无过期时间，无需续期） */
export function machineTokenRenewalDue(expiresAt: Date | string | null): boolean {
  if (expiresAt == null) return false;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return false;
  return t < Date.now() + MACHINE_TOKEN_RENEW_THRESHOLD_DAYS * 86_400_000;
}

/** 同一用户当前活跃令牌数（签发上限检查用） */
export async function countActiveMachineTokens(app: FastifyInstance, userId: string): Promise<number> {
  const r = await app.pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM machine_tokens
      WHERE user_id::text = $1 AND revoked_at IS NULL AND ${ACTIVE_TOKEN_PREDICATE}`,
    [userId],
  );
  return Number(r.rows[0]?.n ?? 0);
}
