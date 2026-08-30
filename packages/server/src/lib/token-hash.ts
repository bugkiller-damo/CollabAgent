import { createHash } from "node:crypto";

/**
 * 机器/Agent 令牌哈希策略：sha256(token)。
 *
 * 这类令牌是 32 字符随机串（crypto.randomBytes(24) → base64url，192 bit 熵，
 * 生成点见 routes/profile.ts / routes/agents-credentials.ts），离线爆破在数学上不可行，
 * 不需要 bcrypt 的抗暴力破解特性。用 sha256 直接落库后，认证可以
 * `WHERE token_hash = $1` 走唯一索引 O(1) 命中，取代原来「全表扫描 +
 * 逐行 bcrypt.compare」的 O(N×100ms) 热路径。
 *
 * 向后兼容：历史数据里是 bcrypt 哈希（$2a$/$2b$ 前缀），verifyTokenHash
 * 按前缀分流——旧 token 仍能认证，新 token 全走 sha256。等所有旧 token
 * 轮换/吊销后，可删除 bcrypt 分支。
 */
export function sha256Token(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isBcryptHash(hash: string): boolean {
  return hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$");
}

/** 校验单个已落库的哈希：新格式直接比 hex，旧格式走 bcrypt。 */
export async function verifyTokenHash(token: string, storedHash: string): Promise<boolean> {
  if (isBcryptHash(storedHash)) {
    const bcrypt = (await import("bcryptjs")).default;
    return bcrypt.compare(token, storedHash);
  }
  return sha256Token(token) === storedHash;
}
