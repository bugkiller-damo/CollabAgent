import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * 加载 packages/server/.env（若存在）。
 *
 * 用 import.meta.url 定位到包根目录，不依赖进程 cwd——
 * 无论从仓库根 `pnpm dev` 还是 `cd packages/server && pnpm dev` 都能命中同一份 .env。
 * dotenv 默认不覆盖已由进程注入的环境变量（测试/CI 显式传入的 env 优先）。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "../../.env");
if (existsSync(ENV_FILE)) {
  dotenv.config({ path: ENV_FILE });
}

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
  /** 本地开发 DATABASE_URL 回退（与 docker-compose.yml 的 postgres 服务凭据一致）。 */
  DATABASE_URL: "postgresql://collabagent:collabagent_dev@localhost:5432/collabagent",
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
  // 对象存储后端（O4）：local=本地磁盘（默认）；s3|minio=对象存储（MinIO/S3 协议）
  STORAGE_BACKEND: env("STORAGE_BACKEND", "local"),
  S3_ENDPOINT: env("S3_ENDPOINT", ""),
  S3_REGION: env("S3_REGION", "us-east-1"),
  S3_BUCKET: env("S3_BUCKET", ""),
  S3_ACCESS_KEY: env("S3_ACCESS_KEY", ""),
  S3_SECRET_KEY: env("S3_SECRET_KEY", ""),
  S3_FORCE_PATH_STYLE: env("S3_FORCE_PATH_STYLE", ""),
  // 可选：公共桶/CDN 直链基地址（https://cdn.example.com）；不配置则经 /api/attachments/by-key 代理
  S3_PUBLIC_BASE_URL: env("S3_PUBLIC_BASE_URL", ""),
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
  // O4：选了对象存储后端就必须给全连接参数，否则上传下载全链路在生产直接失败
  const backend = String(e.STORAGE_BACKEND || "local").toLowerCase();
  if (backend === "s3" || backend === "minio") {
    for (const key of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const) {
      if (!e[key]) issues.push(`STORAGE_BACKEND=${backend} 需要设置 ${key}（对象存储连接参数缺失）`);
    }
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
