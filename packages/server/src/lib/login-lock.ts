import { config } from "./config.js";

/**
 * O6 登录防爆破：双 key（账号 + IP）失败计数，状态落共享存储（Valkey）。
 *
 * 原实现是 auth.ts 里的单进程内存 Map：重启清零、多实例不共享、只有账号一个维度
 * （换 IP 撞同一账号不受限）。这里改为：
 * - `login:acct:<账号>`：同账号 5 次失败锁 15 分钟，换 IP 依旧锁定（防撞库）；
 * - `login:ip:<IP>`：同 IP 累计失败达到更高阈值（默认 20）锁 15 分钟（防分布式喷洒，
 *   NAT 用户多账号共享 IP，阈值必须显著高于账号维度）；
 * - Valkey 可用时走 INCR+PEXPIRE（多实例共享）；未配置回退进程内存（单实例/测试）。
 *
 * 语义：固定窗口（自第一次失败起 LOGIN_LOCK_MS），成功登录清除两个 key 的计数。
 * Valkey 异常时 fail-open（不因限流组件故障拒绝登录），与 lib/rate-limit.ts 一致。
 */

export const LOGIN_ACCOUNT_PREFIX = "login:acct:";
export const LOGIN_IP_PREFIX = "login:ip:";

/** ioredis 的最小结构子集：单测可注入 fake。 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number, mode?: "NX"): Promise<number>;
  get(key: string): Promise<string | null>;
  pttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

export interface LoginLockStore {
  /** 记一次失败：返回该 key 当前失败数与是否已达锁定阈值。 */
  recordFailure(key: string): Promise<{ failures: number; locked: boolean }>;
  /** 剩余锁定毫秒；未锁定返回 0。 */
  remainingLockMs(key: string): Promise<number>;
  /** 清除计数（成功登录后调用）。 */
  clear(key: string): Promise<void>;
}

export class MemoryLoginLockStore implements LoginLockStore {
  private store = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {
    // 惰性过期 + 定时清扫，防僵尸 key 堆积
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.store) if (now - v.windowStart >= this.windowMs) this.store.delete(k);
    }, 60_000);
  }

  private live(key: string): { count: number; windowStart: number } | undefined {
    const rec = this.store.get(key);
    if (!rec) return undefined;
    if (Date.now() - rec.windowStart >= this.windowMs) {
      this.store.delete(key);
      return undefined;
    }
    return rec;
  }

  async recordFailure(key: string): Promise<{ failures: number; locked: boolean }> {
    const rec = this.live(key) ?? { count: 0, windowStart: Date.now() };
    rec.count += 1;
    this.store.set(key, rec);
    return { failures: rec.count, locked: rec.count >= this.max };
  }

  async remainingLockMs(key: string): Promise<number> {
    const rec = this.live(key);
    if (!rec || rec.count < this.max) return 0;
    return Math.max(0, rec.windowStart + this.windowMs - Date.now());
  }

  async clear(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class ValkeyLoginLockStore implements LoginLockStore {
  constructor(
    private r: RedisLike,
    private max: number,
    private windowMs: number,
  ) {}

  async recordFailure(key: string): Promise<{ failures: number; locked: boolean }> {
    try {
      const count = await this.r.incr(key);
      if (count === 1) await this.r.pexpire(key, this.windowMs, "NX");
      return { failures: count, locked: count >= this.max };
    } catch {
      return { failures: 0, locked: false }; // fail-open
    }
  }

  async remainingLockMs(key: string): Promise<number> {
    try {
      const n = Number((await this.r.get(key)) ?? 0);
      if (n < this.max) return 0;
      const ttl = await this.r.pttl(key);
      if (ttl === -2) return 0; // key 不存在
      if (ttl === -1) return this.windowMs; // 无过期（异常兜底：按全窗口）
      return ttl;
    } catch {
      return 0; // fail-open
    }
  }

  async clear(key: string): Promise<void> {
    try {
      await this.r.del(key);
    } catch {
      /* fail-open */
    }
  }
}

/** 账号维度阈值/窗口（沿用原常量语义，改从 config 读）。 */
const ACCOUNT_MAX = config.LOGIN_MAX_ATTEMPTS;
const LOCK_WINDOW_MS = config.LOGIN_LOCK_MS;
/** IP 维度阈值：NAT 共享 IP，必须显著高于账号阈值。 */
const IP_MAX = config.LOGIN_IP_MAX_ATTEMPTS;

/** Valkey 可用则共享存储；否则进程内存（与 rate-limit 相同的选择逻辑）。 */
const { default: Redis } = await import("ioredis");

const accountStore: LoginLockStore = config.VALKEY_URL
  ? new ValkeyLoginLockStore(
      new Redis(config.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 }),
      ACCOUNT_MAX,
      LOCK_WINDOW_MS,
    )
  : new MemoryLoginLockStore(ACCOUNT_MAX, LOCK_WINDOW_MS);
const ipStore: LoginLockStore = config.VALKEY_URL
  ? new ValkeyLoginLockStore(
      new Redis(config.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 }),
      IP_MAX,
      LOCK_WINDOW_MS,
    )
  : new MemoryLoginLockStore(IP_MAX, LOCK_WINDOW_MS);

/** 账号归一化：小写（登录按 handle/email 均可，保持与原 lockKey 一致）。 */
export function normalizeAccount(login: string): string {
  return String(login || "")
    .trim()
    .toLowerCase();
}

/** 客户端 IP：尊重反向代理的 x-forwarded-for（取第一个），否则 req.ip。 */
export function clientIpOf(req: { headers?: Record<string, unknown>; ip?: string }): string {
  const xff = (req.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return String(xff || req.ip || "").slice(0, 64);
}

/** 当前锁定剩余毫秒：账号与 IP 两个维度取最大值（任一命中即锁）。 */
export async function loginLockRemainingMs(account: string, ip: string): Promise<number> {
  const [a, i] = await Promise.all([
    accountStore.remainingLockMs(LOGIN_ACCOUNT_PREFIX + account),
    ipStore.remainingLockMs(LOGIN_IP_PREFIX + ip),
  ]);
  return Math.max(a, i);
}

/** 登录失败：账号与 IP 两个维度各记一次。 */
export async function recordLoginFailure(account: string, ip: string): Promise<void> {
  await Promise.all([
    accountStore.recordFailure(LOGIN_ACCOUNT_PREFIX + account),
    ipStore.recordFailure(LOGIN_IP_PREFIX + ip),
  ]);
}

/** 登录成功：清除账号与 IP 计数（成功证明持有凭据，不应累积历史失败）。 */
export async function clearLoginFailures(account: string, ip: string): Promise<void> {
  await Promise.all([accountStore.clear(LOGIN_ACCOUNT_PREFIX + account), ipStore.clear(LOGIN_IP_PREFIX + ip)]);
}
