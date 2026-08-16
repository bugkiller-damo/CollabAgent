/**
 * 集中配置管理 — 所有环境变量在此统一读取/校验。
 *
 * 安全模型（O5）：
 * - 本地开发允许使用已知默认值（仅 console.warn 提醒）；
 * - NODE_ENV=production 时命中任一危险默认值即拒绝启动（process.exit(1)）；
 * - 本地调试生产模式可显式 ALLOW_INSECURE_DEV_SECRETS=1 跳过，禁止真实部署使用。
 */
function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/** 已知不安全的开发默认值——生产环境命中即视为配置事故。 */
export const INSECURE_DEV_DEFAULTS = {
  JWT_SECRET: "dev-secret-change-in-production",
  REFRESH_SECRET: "dev-refresh-secret",
  /** 本地开发 DATABASE_URL 回退（本机 docker 实例，不含历史明文密码 P@ssw0rd）。 */
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/collabagent",
} as const;

export const config = {
  PORT: Number(process.env.PORT) || 3001,
  HOST: process.env.HOST || "0.0.0.0",
  DATABASE_URL: env("DATABASE_URL", INSECURE_DEV_DEFAULTS.DATABASE_URL),
  DB_POOL_MAX: Number(process.env.DB_POOL_MAX) || 10,
  JWT_SECRET: env("JWT_SECRET", INSECURE_DEV_DEFAULTS.JWT_SECRET),
  REFRESH_SECRET: env("REFRESH_SECRET", INSECURE_DEV_DEFAULTS.REFRESH_SECRET),
  MAX_UPLOAD_SIZE: Number(process.env.MAX_UPLOAD_SIZE) || 10 * 1024 * 1024,
  ALLOWED_MIME_TYPES: (
    process.env.ALLOWED_MIME_TYPES ||
    "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,application/zip,application/json"
  ).split(","),
  // 限流后端（Valkey / Redis 兼容协议）。VALKEY_URL 优先，REDIS_URL 为旧变量名兼容读取。
  VALKEY_URL: env("VALKEY_URL", env("REDIS_URL", "")),
  LOGIN_MAX_ATTEMPTS: Number(process.env.LOGIN_MAX_ATTEMPTS) || 5,
  LOGIN_LOCK_MS: Number(process.env.LOGIN_LOCK_MS) || 15 * 60 * 1000,
} as const;

/**
 * 收集不安全配置项（纯函数，可单测）。
 * 返回人类可读的问题列表；空数组表示配置安全。
 */
export function collectInsecureConfig(e: NodeJS.ProcessEnv = process.env): string[] {
  const issues: string[] = [];
  if (!e.JWT_SECRET) {
    issues.push("JWT_SECRET 未设置（当前使用公开已知默认值，任何人可伪造 JWT）");
  } else if (e.JWT_SECRET === INSECURE_DEV_DEFAULTS.JWT_SECRET) {
    issues.push("JWT_SECRET 使用了公开已知默认值 dev-secret-change-in-production");
  }
  if (!e.REFRESH_SECRET) {
    issues.push("REFRESH_SECRET 未设置（当前使用公开已知默认值）");
  } else if (e.REFRESH_SECRET === INSECURE_DEV_DEFAULTS.REFRESH_SECRET) {
    issues.push("REFRESH_SECRET 使用了公开已知默认值 dev-refresh-secret");
  }
  if (!e.DATABASE_URL) {
    issues.push("DATABASE_URL 未设置（生产环境必须显式指定数据库连接串）");
  }
  return issues;
}

export function validateConfig(): void {
  const issues = collectInsecureConfig();
  if (issues.length === 0) return;

  const isProd = process.env.NODE_ENV === "production";
  const allowInsecure = process.env.ALLOW_INSECURE_DEV_SECRETS === "1";

  if (!isProd || allowInsecure) {
    for (const issue of issues) console.warn(`[Config] ⚠️ ${issue}`);
    if (isProd && allowInsecure) {
      console.warn("[Config] ⚠️ ALLOW_INSECURE_DEV_SECRETS=1 已生效——仅限本地调试，禁止用于真实部署");
    }
    return;
  }

  console.error("[Config] ❌ 生产环境检测到不安全配置，拒绝启动：");
  for (const issue of issues) console.error(`  - ${issue}`);
  console.error("[Config] 请通过环境变量设置上述配置项；本地调试可显式 ALLOW_INSECURE_DEV_SECRETS=1 跳过。");
  process.exit(1);
}
