// 评估报告 P1.15：令牌校验收敛——此前 sk_machine_ 机器令牌校验（sha256 快路径 +
// 滚动续期 + bcrypt 兼容路径 + P1.14 护栏）在 index.ts（authenticate 装饰器）与
// ws/handler.ts（resolveUserId）逐行重复两份，修 bug 必改两处；浏览器 JWT 则是
// WS 侧用 jsonwebtoken 直验，与 @fastify/jwt 双库并存、靠注释约定保持 secret 同步，
// 且 WS 不做 session 回查（logout-all 后 WS 长连接仍有效）。
// 本文件把两侧校验收敛为 HTTP/WS 共用的单一实现：
// - verifyMachineToken：机器令牌校验（renewal=threshold 供 HTTP 用 / always 供 WS）；
// - verifyBrowserToken：浏览器 access token 校验（统一走 @fastify/jwt access
//   namespace，并强制 sid + 会话回查）。

import { machineTokenBcryptGuard } from "./machine-token-guard.js";
import { ACTIVE_TOKEN_PREDICATE, BCRYPT_TOKEN_PREDICATE, machineTokenRenewalDue } from "./machine-token-policy.js";
import { isSessionValid } from "./session-check.js";
import { isBcryptHash, sha256Token } from "./token-hash.js";

/** 最小 pg 形状：Fastify server.pg 与 WS 注入的 wsPg 都满足 */
export interface TokenPg {
  query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

/** bcrypt 兼容路径护栏的最小形状（默认共享 machineTokenBcryptGuard 单例，测试注入用） */
export interface MachineTokenGuardLike {
  tryEnter(ip: string): Promise<"allowed" | "rate_limited" | "busy">;
  release(): void;
}

export interface VerifyMachineTokenOptions {
  /** 护栏 per-IP 速率预算的键（HTTP=request.ip，WS=握手连接 IP） */
  clientIp?: string;
  /** 续期策略：threshold=阈值门控（HTTP，压写放大）；always=连接即续期（WS） */
  renewal: "threshold" | "always";
  /** 结构化 warn（HTTP=request.log，WS=console 包装）；缺省静默 */
  log?: { warn: (obj: unknown, msg: string) => void };
  /** 默认共享单例 machineTokenBcryptGuard（HTTP/WS 共用同一份预算），测试注入用 */
  guard?: MachineTokenGuardLike;
}

export type MachineTokenVerdict =
  | {
      ok: true;
      userId: string;
      scope: string;
      tokenId: string;
      expiresAt: Date | null;
      handle: string;
      legacy: boolean;
    }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "guard-rejected"; guardVerdict: string };

/**
 * 校验 sk_machine_ 机器令牌（HTTP authenticate 装饰器与 WS resolveUserId 共用）。
 * 快路径：sha256 按唯一索引命中；未命中走 bcrypt 兼容路径（先过 P1.14 护栏）。
 * 调用方按 verdict 决定 HTTP 401/429 或 WS 4001 关闭。
 */
export async function verifyMachineToken(
  pg: TokenPg,
  token: string,
  opts: VerifyMachineTokenOptions,
): Promise<MachineTokenVerdict> {
  const { clientIp = "", renewal, log } = opts;
  // 快路径：sha256 哈希直接按唯一索引命中（新签发的令牌都走这里）。
  // P1.12：过期谓词拒绝超期令牌（NULL 豁免存量行，见 lib/machine-token-policy.ts）。
  const fast = await pg.query<{ id: string; user_id: string; scope: string; expires_at: Date | null }>(
    `SELECT id, user_id, scope, expires_at FROM machine_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND ${ACTIVE_TOKEN_PREDICATE}`,
    [sha256Token(token)],
  );
  if (fast.rows.length > 0) {
    const row = fast.rows[0]!;
    const user = await pg.query<{ id: string; handle: string }>("SELECT id, handle FROM users WHERE id = $1", [
      row.user_id,
    ]);
    if (user.rows.length === 0) return { ok: false, reason: "invalid" };
    // P1.12 滚动续期：HTTP 每请求都走这里，阈值门控（剩余 <30 天才写库顺延到
    // +90 天）把写放大压到每令牌最多每 60 天一次；WS 连接频率低，连接即续期
    // （renewal="always"），与 HTTP 阈值续期共同构成「活跃令牌不过期」。
    // 续期失败不影响本次认证结果。
    if (renewal === "always" || machineTokenRenewalDue(row.expires_at)) {
      try {
        await pg.query("UPDATE machine_tokens SET expires_at = now() + interval '90 days' WHERE id = $1", [row.id]);
      } catch (e) {
        log?.warn({ err: e }, "machine token rolling renewal failed (non-fatal)");
      }
    }
    return {
      ok: true,
      userId: String(row.user_id),
      scope: row.scope,
      tokenId: row.id,
      expiresAt: row.expires_at,
      handle: user.rows[0]!.handle,
      legacy: false,
    };
  }
  // 兼容路径：历史 bcrypt 哈希的令牌（等全部轮换/吊销后可删除此分支，O8）。
  // 观测：machineAuthBcryptScans/Hits 计数器（/api/metrics）+ 命中 warn 日志；
  // 退役判定见 docs/2026-08-16/08-bcrypt-token-retirement.md。
  // P1.12：同样拒绝过期令牌；此路径不做滚动续期——存量 bcrypt 令牌靠过期
  // 压力促成轮换退役。
  // P1.14：未知令牌走此路径 = 全表拉取 + 逐行 bcrypt（O(N×12) CPU）的 DoS
  // 放大面——先过全局护栏（per-IP 速率 + 并发信号量，HTTP/WS 共用单例，
  // 见 lib/machine-token-guard.ts），超限直接拒绝（HTTP 429 / WS 4001），
  // 不再触达 DB 与 bcrypt。
  const { inc } = await import("./metrics.js");
  const guard = opts.guard ?? machineTokenBcryptGuard;
  const verdict = await guard.tryEnter(clientIp);
  if (verdict !== "allowed") {
    inc("machineAuthBcryptRejected");
    log?.warn({ verdict }, "machine token bcrypt fallback rejected by guard");
    return { ok: false, reason: "guard-rejected", guardVerdict: verdict };
  }
  try {
    inc("machineAuthBcryptScans");
    const bcrypt = (await import("bcryptjs")).default;
    // SQL 侧按 bcrypt 哈希形态预过滤（P1.14，与退役审计 SQL 同口径）：存量
    // 全部轮换为 sha256 后此查询稳定 0 行；JS 侧 isBcryptHash 保留作纵深防御。
    const legacy = await pg.query<{ user_id: string; scope: string; token_hash: string }>(
      `SELECT user_id, scope, token_hash FROM machine_tokens
        WHERE revoked_at IS NULL AND ${ACTIVE_TOKEN_PREDICATE} AND ${BCRYPT_TOKEN_PREDICATE}`,
    );
    for (const row of legacy.rows) {
      if (isBcryptHash(row.token_hash) && (await bcrypt.compare(token, row.token_hash))) {
        inc("machineAuthBcryptHits");
        log?.warn(
          { userId: row.user_id, scope: row.scope },
          "legacy bcrypt machine token used — rotate/revoke it (see 08-bcrypt-token-retirement.md)",
        );
        const user = await pg.query<{ id: string; handle: string }>("SELECT id, handle FROM users WHERE id = $1", [
          row.user_id,
        ]);
        if (user.rows.length > 0) {
          return {
            ok: true,
            userId: String(row.user_id),
            scope: row.scope,
            tokenId: "",
            expiresAt: null,
            handle: user.rows[0]!.handle,
            legacy: true,
          };
        }
      }
    }
  } finally {
    guard.release();
  }
  return { ok: false, reason: "invalid" };
}

// ---------------- 浏览器 access token（HTTP/WS 共用） ----------------

export interface BrowserTokenPayload {
  userId: string;
  sid: string;
  tv?: string;
  handle?: string;
  [k: string]: unknown;
}

/**
 * 校验浏览器 access token（httpOnly cookie 里的 JWT）。HTTP（authenticate 装饰器）
 * 与 WS（握手 cookie）共用——此前 WS 侧 jsonwebtoken 直验，与 @fastify/jwt 双库
 * 并存靠注释约定同步 secret，且不做 session 回查（logout-all 后长连接仍有效）。
 *
 * - jwt / pg / token 任一缺失 → null（fail-closed）；
 * - P1.15 强制 sid（fail-closed）：payload.sid 缺失 → null——存量无 sid 的旧
 *   token 不再跳过会话回查，直接拒绝、强制重新登录（与 P1.16「sid 必须存在」
 *   对齐，有意收紧）；
 * - 会话状态回查：logout-all / 改密 / 注销会吊销 session 或滚动 token_version，
 *   不查的话旧 access token 在 7 天有效期内仍能用（lib/session-check.ts，5s 缓存）。
 */
export async function verifyBrowserToken(
  jwt: { verify(token: string): unknown } | undefined,
  pg: TokenPg | null,
  token: string | null | undefined,
): Promise<BrowserTokenPayload | null> {
  if (!jwt || !pg || !token) return null;
  let payload: any;
  try {
    payload = jwt.verify(token);
  } catch {
    return null;
  }
  if (!payload?.sub) return null;
  if (!payload.sid) return null;
  if (!(await isSessionValid(pg, String(payload.sid), String(payload.sub), payload.tv))) {
    return null;
  }
  // 整个 payload 摊开进返回值，HTTP 侧 request.user 保留原字段（sub/sid/tv/handle）。
  return { ...payload, userId: String(payload.sub), sid: String(payload.sid) };
}
