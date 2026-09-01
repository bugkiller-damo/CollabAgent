import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * P1.20：找回密码验证码（dev 显式开关模式）的纯函数部分。
 *
 * 仓库无邮件基建：完整验证码流仅在 SLOCK_DEV_RESET_CODE=1 时开启（验证码经响应体
 * devCode 字段回传，配合 web ForgotPasswordPage.vue 既有契约），生产环境由
 * collectInsecureConfig 标记并拒绝启动——同 P1.17 SLOCK_DEV_TOKEN 模式。
 * 开关关闭时路由恒返回诚实文案、不落任何状态（无假成功）。
 *
 * 存储：users.reset_code 只存 sha256(code) 十六进制（020 迁移拓宽到 VARCHAR(64)），
 * TTL 10 分钟（users.reset_expires），单次使用（消费即清空）。SQL 流程在 routes/auth.ts。
 */
export const RESET_CODE_TTL_MS = 10 * 60 * 1000;

/** 6 位十进制验证码：CSPRNG + 拒绝采样（消除 uint32 % 1e6 的微小模偏，2^32 % 1e6 ≠ 0） */
export function generateResetCode(): string {
  const MAX = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / MAX) * MAX;
  let n: number;
  do {
    n = randomBytes(4).readUInt32BE(0);
  } while (n >= limit);
  return String(n % MAX).padStart(6, "0");
}

/** 验证码只以 sha256 十六进制形态落库/比对 */
export function hashResetCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 时序安全比对：两侧归一为等长字节（sha256 hex）后再比，无提前返回时序差 */
export function resetCodeMatches(code: string, storedHash: string): boolean {
  const a = Buffer.from(hashResetCode(code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
