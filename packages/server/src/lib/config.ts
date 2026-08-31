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

/**
 * P1.13：解析 TRUST_PROXY 环境变量为 Fastify trustProxy 选项值（纯函数，可单测）。
 * 默认（空/"false"）不信任任何代理——req.ip 即 TCP 对端地址，伪造 X-Forwarded-For
 * 无法影响 IP 判定（fail-closed）；仅当部署确认处于已知反代链后时才显式声明：
 * "true"（全信任，仅限确信流量全部经过可信反代）或逗号分隔的可信代理 IP/CIDR 列表
 * （nginx 同机反代填 127.0.0.1；不支持 Express 式跳数——Fastify 语义无此选项，
 * IP 列表比跳数更精确，还天然排除不可信链路上的伪造 XFF）。
 */
export function parseTrustProxy(raw: string): boolean | string[] {
  const v = String(raw || "").trim();
  if (!v || v === "false") return false;
  if (v === "true") return true;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * P1.17：解析 COOKIE_SECURE 环境变量为 Cookie Secure 属性判定（纯函数，可单测）。
 * "1"/"true"/"yes"/"on" 显式开启；"0"/"false"/"no"/"off" 显式关闭；空或未识别
 * → "auto"（由应用层按 NODE_ENV=production 判定）。应用层自行判定而非依赖
 * 反代改写 Set-Cookie——部署疏漏不再导致凭据明文传输（httpOnly access cookie）。
 */
export function parseCookieSecure(raw: string): boolean | "auto" {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return "auto";
}

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
  // O14：web 前端 dist 目录（生产静态托管）。空 = 按源码布局自动定位 ../web/dist；
  // 目录不存在（本地 vite 开发 / 纯后端部署）时自动跳过 SPA 托管。
  WEB_DIST_DIR: env("WEB_DIST_DIR", ""),
  LOGIN_MAX_ATTEMPTS: Number(process.env.LOGIN_MAX_ATTEMPTS) || 5,
  LOGIN_LOCK_MS: Number(process.env.LOGIN_LOCK_MS) || 15 * 60 * 1000,
  // IP 维度登录失败阈值（NAT 共享 IP，默认显著高于账号维度）
  LOGIN_IP_MAX_ATTEMPTS: Number(process.env.LOGIN_IP_MAX_ATTEMPTS) || 20,
  // P1.13：反代信任链——默认空 = 不信任任何代理（req.ip = TCP 对端，XFF 忽略）。
  // 确认部署在反代后时显式设置：true（全信任）或可信代理 IP/CIDR 列表
  // （nginx 同机反代填 127.0.0.1），之后 req.ip 才按 X-Forwarded-For 解析
  // （限流与登录锁定共用同一判定）。
  TRUST_PROXY: parseTrustProxy(env("TRUST_PROXY", "")),
  // P1.17：Cookie Secure 属性判定（"auto" = NODE_ENV=production 时开启；应用层
  // 判定，不依赖反代改写）。显式覆盖见 parseCookieSecure。
  COOKIE_SECURE: parseCookieSecure(env("COOKIE_SECURE", "")),
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
  // P1.17：dev-token 无凭据后门显式开启即标记——生产环境经 validateConfig 直接
  // 拒绝启动（本地开发仅告警），配合 index.ts authenticate 的显式开关。
  if (e.SLOCK_DEV_TOKEN === "1") {
    issues.push("SLOCK_DEV_TOKEN=1（dev-token 无凭据后门已开启，仅限本地开发调试，禁止用于真实部署）");
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
