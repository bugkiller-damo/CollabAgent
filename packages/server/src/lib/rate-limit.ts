/**
 * 全局限流中间件 — 支持 Valkey/Redis（ioredis，协议兼容）和内存两种后端。
 */
import { config } from "./config.js";

const { default: Redis } = await import("ioredis");

interface RateLimitOpts {
  windowMs: number;
  max: number;
  message?: string;
}

const DEFAULTS: Record<string, RateLimitOpts> = {
  auth: { windowMs: 60_000, max: 20, message: "请求过于频繁，请稍后再试" },
  api: { windowMs: 60_000, max: 100, message: "请求过于频繁，请稍后再试" },
  sensitive: { windowMs: 60_000, max: 5, message: "操作过于频繁，请稍后再试" },
};

class MemoryBackend {
  private store = new Map<string, { count: number; resetAt: number }>();
  async check(key: string, opts: RateLimitOpts) {
    const now = Date.now();
    const record = this.store.get(key);
    if (!record || record.resetAt < now) {
      this.store.set(key, { count: 1, resetAt: now + opts.windowMs });
      return { allowed: true, remaining: opts.max - 1 };
    }
    record.count++;
    return record.count > opts.max
      ? { allowed: false, remaining: 0 }
      : { allowed: true, remaining: opts.max - record.count };
  }
  startCleanup() {
    setInterval(() => {
      const n = Date.now();
      for (const [k, v] of this.store) if (v.resetAt < n) this.store.delete(k);
    }, 60_000);
  }
}

class ValkeyBackend {
  private r: any;
  constructor(url: string) {
    this.r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }
  async check(key: string, opts: RateLimitOpts) {
    try {
      const r = await this.r.multi().incr(key).pexpire(key, opts.windowMs, "NX").exec();
      return { allowed: r[0][1] <= opts.max, remaining: Math.max(0, opts.max - r[0][1]) };
    } catch {
      return { allowed: true, remaining: 1 };
    }
  }
}

const backend = config.VALKEY_URL
  ? new ValkeyBackend(config.VALKEY_URL)
  : (() => {
      const m = new MemoryBackend();
      m.startCleanup();
      return m;
    })();

function optsFor(url: string): RateLimitOpts {
  // sensitive 桶：改密/注销等高危操作。注意 change-password 的实际路由是
  // /api/profile/change-password（P1.28 测试实锤：旧正则的裸 `change-password`
  // 分支要求 /api/ 后紧跟，永远匹配不到，该桶此前对改密从未生效）
  if (/\/api\/(profile\/(deactivate|change-password)|auth\/deactivate)/.test(url)) return DEFAULTS.sensitive;
  if (/\/api\/auth\/(login|register|refresh)/.test(url)) return DEFAULTS.auth;
  return DEFAULTS.api;
}

export async function rateLimitHook(request: any, reply: any) {
  if (request.url === "/api/health") return;
  // 测试环境跳过限流
  if (process.env.NODE_ENV === "test") return;
  // key 只取 pathname（去 query string）——否则改 query 参数就能绕过限流桶
  const path = (request.url || "").split("?")[0];
  const result = await backend.check(`${request.ip}:${request.method}:${path}`, optsFor(path));
  if (!result.allowed) reply.status(429).send({ error: "请求过于频繁，请稍后再试" });
}
