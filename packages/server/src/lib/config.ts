/**
 * 集中配置管理 — 所有环境变量在此统一读取/校验。
 */
function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  PORT: Number(process.env.PORT) || 3001,
  HOST: process.env.HOST || "0.0.0.0",
  DATABASE_URL: env("DATABASE_URL", "postgresql://postgres:P@ssw0rd@localhost:5432/collabagent"),
  DB_POOL_MAX: Number(process.env.DB_POOL_MAX) || 10,
  JWT_SECRET: env("JWT_SECRET", "dev-secret-change-in-production"),
  REFRESH_SECRET: env("REFRESH_SECRET", "dev-refresh-secret"),
  MAX_UPLOAD_SIZE: Number(process.env.MAX_UPLOAD_SIZE) || 10 * 1024 * 1024,
  ALLOWED_MIME_TYPES: (process.env.ALLOWED_MIME_TYPES || "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,application/zip,application/json").split(","),
  REDIS_URL: process.env.REDIS_URL || "",
  LOGIN_MAX_ATTEMPTS: Number(process.env.LOGIN_MAX_ATTEMPTS) || 5,
  LOGIN_LOCK_MS: Number(process.env.LOGIN_LOCK_MS) || 15 * 60 * 1000,
} as const;

export function validateConfig(): void {
  if (config.JWT_SECRET === "dev-secret-change-in-production") console.warn("[Config] ⚠️ JWT_SECRET 使用默认值，请通过环境变量设置");
  if (config.REFRESH_SECRET === "dev-refresh-secret") console.warn("[Config] ⚠️ REFRESH_SECRET 使用默认值，请通过环境变量设置");
}
