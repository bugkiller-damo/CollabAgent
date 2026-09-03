import { afterEach, beforeEach, describe, expect, it } from "vitest";
// P1.27：跨实例 daemon 在线注册表单测（离线——不依赖真 Redis，注入 fake client）。
// 真双实例行为（Redis 集合 + 两进程读路径互通）由行为探针 scripts/probe-p127-presence.mjs 覆盖。
import {
  __resetPresenceForTests,
  isComputerOnline,
  onlineUserSnapshot,
  type PresenceRedisClient,
  presenceAdd,
  presenceRemove,
  startPresenceSync,
} from "../src/lib/presence.js";

/** 内存版 Redis 客户端：实现 presence 用到的最小命令面，可注入故障。 */
class FakeRedis implements PresenceRedisClient {
  store = new Map<string, Set<string>>();
  fail = false;

  async sadd(key: string, ...members: string[]) {
    if (this.fail) throw new Error("redis down");
    const set = this.store.get(key) ?? new Set<string>();
    for (const m of members) set.add(m);
    this.store.set(key, set);
    return set.size;
  }
  async srem(key: string, ...members: string[]) {
    if (this.fail) throw new Error("redis down");
    const set = this.store.get(key);
    if (set) for (const m of members) set.delete(m);
    return 1;
  }
  async expire() {
    if (this.fail) throw new Error("redis down");
    return 1;
  }
  async scan(cursor: string): Promise<[string, string[]]> {
    if (this.fail) throw new Error("redis down");
    return ["0", [...this.store.keys()]];
  }
  async smembers(key: string) {
    if (this.fail) throw new Error("redis down");
    return [...(this.store.get(key) ?? [])];
  }
  async quit() {}
}

const OTHER_KEY = "slock:presence:v1:other-instance";

function waitFor(fn: () => boolean, timeout = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeout) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, 20);
  });
}

beforeEach(() => __resetPresenceForTests());
afterEach(() => __resetPresenceForTests());

describe("presence registry（本地模式，未注入 client / 未配 VALKEY_URL）", () => {
  it("连接/断开即时反映在本地视图，快照为本地并集", () => {
    expect(isComputerOnline("u1")).toBe(false);
    presenceAdd("u1");
    expect(isComputerOnline("u1")).toBe(true);
    expect(onlineUserSnapshot().has("u1")).toBe(true);
    presenceRemove("u1");
    expect(isComputerOnline("u1")).toBe(false);
    expect(onlineUserSnapshot().size).toBe(0);
  });

  it("未配置后端时 startPresenceSync 返回 no-op cleanup，不抛错", () => {
    const cleanup = startPresenceSync(60000); // 测试环境无 VALKEY_URL → 纯本地
    expect(() => cleanup()).not.toThrow();
    presenceAdd("u1");
    expect(isComputerOnline("u1")).toBe(true);
  });
});

describe("presence registry（注入 fake client，模拟跨实例）", () => {
  it("远端实例键的用户经扫描并集可见；本实例 SADD/SREM 落到自己的键", async () => {
    const fake = new FakeRedis();
    // 另一实例持有 u-remote
    await fake.sadd(OTHER_KEY, "u-remote");
    startPresenceSync(25, { client: fake });

    // 本实例连接即时可见（写路径直改缓存），且 SADD 已落到自己的键
    presenceAdd("u-local");
    expect(isComputerOnline("u-local")).toBe(true);
    await waitFor(() => [...fake.store.keys()].some((k) => k !== OTHER_KEY && fake.store.get(k)!.has("u-local")));

    // 跨实例：远端用户经扫描进入缓存
    await waitFor(() => isComputerOnline("u-remote"));

    // 远端实例断开（其键成员移除）→ 下一轮扫描收敛为离线
    await fake.srem(OTHER_KEY, "u-remote");
    await waitFor(() => !isComputerOnline("u-remote"));

    // 本实例断开 → SREM 即时落键
    presenceRemove("u-local");
    await waitFor(() => ![...fake.store.values()].some((s) => s.has("u-local")));
    expect(isComputerOnline("u-local")).toBe(false);
  });

  it("Redis 故障：SADD/扫描失败被吞掉，缓存保持最后已知值，本地路径不受影响", async () => {
    const fake = new FakeRedis();
    await fake.sadd(OTHER_KEY, "u-remote");
    startPresenceSync(25, { client: fake });
    await waitFor(() => isComputerOnline("u-remote")); // 先学到远端状态

    fake.fail = true; // 模拟 Redis 抖动
    presenceAdd("u3"); // SADD 被拒（吞掉），本地视图仍即时
    await new Promise((r) => setTimeout(r, 120)); // 跨过 ≥2 个故障 tick
    expect(isComputerOnline("u-remote")).toBe(true); // 缓存不清空（避免抖动期间全线闪离）
    expect(isComputerOnline("u3")).toBe(true); // 本地路径不受影响
  });
});
