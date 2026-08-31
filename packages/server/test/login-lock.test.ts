import { describe, expect, it } from "vitest";
import {
  clearLoginFailures,
  clientIpOf,
  LOGIN_ACCOUNT_PREFIX,
  LOGIN_IP_PREFIX,
  loginLockRemainingMs,
  MemoryLoginLockStore,
  normalizeAccount,
  type RedisLike,
  recordLoginFailure,
  ValkeyLoginLockStore,
} from "../src/lib/login-lock.js";

// ===================== 内存后端 =====================

describe("MemoryLoginLockStore", () => {
  it("达到阈值前不锁，达到后锁定", async () => {
    const s = new MemoryLoginLockStore(3, 60_000);
    const a = await s.recordFailure("k1");
    expect(a).toEqual({ failures: 1, locked: false });
    await s.recordFailure("k1");
    const c = await s.recordFailure("k1");
    expect(c).toEqual({ failures: 3, locked: true });
    expect(await s.remainingLockMs("k1")).toBeGreaterThan(0);
    expect(await s.remainingLockMs("k1")).toBeLessThanOrEqual(60_000);
  });

  it("clear 后计数归零", async () => {
    const s = new MemoryLoginLockStore(3, 60_000);
    await s.recordFailure("k2");
    await s.recordFailure("k2");
    await s.clear("k2");
    expect(await s.remainingLockMs("k2")).toBe(0);
    const r = await s.recordFailure("k2");
    expect(r).toEqual({ failures: 1, locked: false });
  });

  it("窗口过期后重新计数（固定窗口）", async () => {
    const s = new MemoryLoginLockStore(2, 60);
    await s.recordFailure("k3");
    const locked = await s.recordFailure("k3");
    expect(locked.locked).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(await s.remainingLockMs("k3")).toBe(0);
    const r = await s.recordFailure("k3");
    expect(r).toEqual({ failures: 1, locked: false });
  });
});

// ===================== Valkey 后端（fake RedisLike） =====================

class FakeRedis implements RedisLike {
  state = new Map<string, { count: number; ttlAt: number }>();
  throwing = false;

  async incr(key: string): Promise<number> {
    if (this.throwing) throw new Error("redis down");
    const s = this.state.get(key) ?? { count: 0, ttlAt: -1 };
    s.count += 1;
    this.state.set(key, s);
    return s.count;
  }
  async pexpire(key: string, ms: number): Promise<number> {
    const s = this.state.get(key);
    if (s) s.ttlAt = Date.now() + ms;
    return 1;
  }
  async get(key: string): Promise<string | null> {
    const s = this.state.get(key);
    return s ? String(s.count) : null;
  }
  async pttl(key: string): Promise<number> {
    const s = this.state.get(key);
    if (!s) return -2;
    if (s.ttlAt < 0) return -1;
    return Math.max(0, s.ttlAt - Date.now());
  }
  async del(...keys: string[]): Promise<number> {
    for (const k of keys) this.state.delete(k);
    return keys.length;
  }
}

describe("ValkeyLoginLockStore", () => {
  it("INCR 计数 + 首次 PEXPIRE 窗口 + 阈值锁定", async () => {
    const fake = new FakeRedis();
    const s = new ValkeyLoginLockStore(fake, 3, 60_000);
    await s.recordFailure("a");
    await s.recordFailure("a");
    const r = await s.recordFailure("a");
    expect(r).toEqual({ failures: 3, locked: true });
    const rec = fake.state.get("a");
    expect(rec?.count).toBe(3);
    expect(rec?.ttlAt).toBeGreaterThan(Date.now());
    expect(await s.remainingLockMs("a")).toBeGreaterThan(0);
  });

  it("未达阈值 remaining 为 0；ttl -2 视为不存在", async () => {
    const fake = new FakeRedis();
    const s = new ValkeyLoginLockStore(fake, 3, 60_000);
    await s.recordFailure("b");
    expect(await s.remainingLockMs("b")).toBe(0);
    expect(await s.remainingLockMs("missing")).toBe(0);
  });

  it("clear 调用 DEL", async () => {
    const fake = new FakeRedis();
    const s = new ValkeyLoginLockStore(fake, 3, 60_000);
    await s.recordFailure("c");
    await s.recordFailure("c");
    await s.clear("c");
    expect(fake.state.has("c")).toBe(false);
  });

  it("Redis 故障 fail-open：不锁、不清不炸", async () => {
    const fake = new FakeRedis();
    fake.throwing = true;
    const s = new ValkeyLoginLockStore(fake, 3, 60_000);
    const r = await s.recordFailure("d");
    expect(r).toEqual({ failures: 0, locked: false });
    expect(await s.remainingLockMs("d")).toBe(0);
    await s.clear("d"); // 不抛
  });
});

// ===================== 纯函数 =====================

describe("normalizeAccount / clientIpOf", () => {
  it("账号小写化 + trim", () => {
    expect(normalizeAccount("  Alice@X.com ")).toBe("alice@x.com");
  });
  it("clientIpOf：一律取 req.ip（P1.13 与限流同源；XFF 由 trustProxy 统一解析，不自行读头），截断 64", () => {
    expect(clientIpOf({ ip: "9.9.9.9" })).toBe("9.9.9.9");
    // 伪造 XFF 不再影响判定——直连场景无法借此绕过 IP 维度登录锁定
    const forged = { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, ip: "9.9.9.9" };
    expect(clientIpOf(forged)).toBe("9.9.9.9");
    expect(clientIpOf({ headers: { "x-forwarded-for": "1.2.3.4" } })).toBe("");
    expect(clientIpOf({})).toBe("");
    expect(clientIpOf({ ip: "x".repeat(100) })).toHaveLength(64);
  });
});

// ===================== 高层 API（进程内存单例，VALKEY 未配置） =====================

describe("login lock 高层 API（双 key）", () => {
  const run = `zzu_${Date.now().toString(36)}`;

  it("账号失败达阈值 → 账号 key 锁定；换 IP 仍锁（per-account 维度）", async () => {
    const acct = `${run}_a@test.local`;
    for (let i = 0; i < 5; i++) await recordLoginFailure(acct, "10.0.0.1");
    // 换 IP 查询：账号维度已锁定
    expect(await loginLockRemainingMs(acct, "10.9.9.9")).toBeGreaterThan(0);
    await clearLoginFailures(acct, "10.0.0.1");
  });

  it("IP 失败达阈值 → IP key 锁定（per-IP 维度，阈值 20）", async () => {
    const acct = `${run}_ip@test.local`;
    for (let i = 0; i < 20; i++) await recordLoginFailure(acct, "10.7.7.7");
    // 换账号同 IP：IP 维度已锁定
    expect(await loginLockRemainingMs(`${run}_other@test.local`, "10.7.7.7")).toBeGreaterThan(0);
    await clearLoginFailures(acct, "10.7.7.7");
  });

  it("成功清除双 key 后归零", async () => {
    const acct = `${run}_ok@test.local`;
    await recordLoginFailure(acct, "10.6.6.6");
    await clearLoginFailures(acct, "10.6.6.6");
    expect(await loginLockRemainingMs(acct, "10.6.6.6")).toBe(0);
  });

  it("key 前缀形态", () => {
    expect(LOGIN_ACCOUNT_PREFIX).toBe("login:acct:");
    expect(LOGIN_IP_PREFIX).toBe("login:ip:");
  });
});
