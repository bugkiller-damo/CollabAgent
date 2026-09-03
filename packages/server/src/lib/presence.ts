/**
 * P1.27：跨实例 daemon 在线注册表。
 *
 * 背景：presence / 在线数的全部读路径（people / computers 接入页 / dispatch 离线告警 /
 * metrics 在线计数）此前基于本实例的 daemonClients Map——多实例部署下 daemon 连在
 * 实例 B 时，实例 A 系统性显示离线（评估 §2.5 中项）。本模块用 Redis SET 维护
 * 「每实例一个键」的在线集合，读路径查「本地 ∪ 全部实例」并集：
 *
 * - 写：每实例一个键 `slock:presence:v1:<processKey>`（processKey 进程级随机 UUID），
 *   成员 = 本实例持有 daemon 连接的 userId；EXPIRE 45s 随同步循环续期。
 *   进程崩溃（kill -9，无 close 事件）残留的键靠 TTL 自愈，不产生永久陈旧条目。
 * - 读：同步循环（默认 3s）SCAN 全部实例键 → SMEMBERS 取并集 → remoteUsers 缓存。
 *   本实例连接/断开即时生效（写路径直接改本地集合与缓存），跨实例状态传播
 *   ≤ 3s + 对端 SADD 时延——presence 是引导性信息（列表徽标/离线告警预检），
 *   秒级陈旧可接受；权威投递路径（sendToDaemon/sendToUser）仍走本实例 socket +
 *   P1.22 per-user pubsub，不受此缓存影响。
 * - 降级：未配置 VALKEY_URL（单实例 / 测试）→ 纯本地集合，行为与旧版完全一致；
 *   Redis 故障 → 缓存保持最后已知值（不清空，避免抖动期间全线闪离），本地路径
 *   不受影响（与 pubsub.ts 同一故障哲学），恢复后下一轮扫描自动收敛。
 *
 * 本地集合由 ws/handler 在 daemon 连接/断开两处镜像维护（全仓仅这两处增删
 * daemonClients），与连接表严格同源。
 */
import { randomUUID } from "node:crypto";

// ESM 下动态加载 ioredis（与 pubsub.ts / rate-limit.ts 一致）。
const { default: Redis } = await import("ioredis");

import { config } from "./config.js";

/** 测试可注入的最小 Redis 客户端面（ioredis 兼容子集）。 */
export interface PresenceRedisClient {
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  smembers(key: string): Promise<string[]>;
  quit?(): Promise<unknown>;
}

const PRESENCE_PREFIX = "slock:presence:v1:";
const KEY_TTL_SEC = 45; // 崩溃实例残留键的自愈上界
// processKey 进程级随机——同机多进程各自持键，崩溃后键随 TTL 过期
const processKey = randomUUID();
const presenceKey = () => PRESENCE_PREFIX + processKey;

// 本实例持有 daemon 连接的用户（ws/handler 镜像维护）
const localUsers = new Set<string>();
// 全部实例（含本实例键）在线用户并集缓存——由同步循环重建
const remoteUsers = new Set<string>();

let client: PresenceRedisClient | null = null;
let ownsClient = false;
let timer: NodeJS.Timeout | null = null;
let warnedKey = "";

function warnOnce(err: unknown): void {
  const e = err as Error;
  const k = `${e?.name}:${e?.message}`;
  if (warnedKey === k) return;
  warnedKey = k;
  console.warn(`[Presence] redis error (suppressed future repeats): ${e?.message ?? err}`);
}

/** daemon 连接建立（ws/handler registerConnection daemon 分支调用）。 */
export function presenceAdd(userId: string): void {
  const uid = String(userId);
  localUsers.add(uid);
  remoteUsers.add(uid); // 本实例写入即时生效，不等下一轮扫描
  if (client) void client.sadd(presenceKey(), uid).catch(warnOnce);
}

/** daemon 断开（ws/handler close 调用）。 */
export function presenceRemove(userId: string): void {
  const uid = String(userId);
  localUsers.delete(uid);
  remoteUsers.delete(uid); // 立即收敛；若他实例真仍持有（双连），下一轮扫描会加回
  if (client) void client.srem(presenceKey(), uid).catch(warnOnce);
}

/** 该用户的 daemon 是否在线（任意实例）。同步读缓存，供既有同步读路径无缝替换。 */
export function isComputerOnline(userId: string): boolean {
  const uid = String(userId);
  return localUsers.has(uid) || remoteUsers.has(uid);
}

/** 全局在线 daemon 用户并集快照（metrics 聚合用）。 */
export function onlineUserSnapshot(): Set<string> {
  return new Set([...localUsers, ...remoteUsers]);
}

/**
 * 启动跨实例同步循环。未配置 VALKEY_URL 且未注入 client 时为纯本地模式（no-op 定时器）。
 * 返回 cleanup（清定时器；不关客户端——注入方自持，自建客户端走 shutdownPresence）。
 */
export function startPresenceSync(intervalMs = 3000, opts?: { client?: PresenceRedisClient }): () => void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (opts?.client) {
    client = opts.client;
    ownsClient = false;
  } else if (!client && config.VALKEY_URL) {
    client = new Redis(config.VALKEY_URL, {
      maxRetriesPerRequest: 1,
      // 有界重连（与 pubsub.ts 同参）：断线期间命令快速失败，恢复后自动续上
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    }) as unknown as PresenceRedisClient;
    ownsClient = true;
    (client as unknown as { on(event: string, cb: (e: Error) => void): void }).on("error", warnOnce);
  }
  if (!client) return () => {};

  const c = client;
  const tick = async () => {
    try {
      // 1) 自愈刷新：重写本实例成员（SADD 幂等，补回 Redis 抖动期间丢失的写）+ 续 TTL
      if (localUsers.size > 0) await c.sadd(presenceKey(), ...[...localUsers]);
      await c.expire(presenceKey(), KEY_TTL_SEC);
      // 2) 全量扫描重建远端缓存（小规模部署实例键个位数，SCAN 代价可忽略）
      const union = new Set<string>();
      let cursor = "0";
      do {
        const [next, keys] = await c.scan(cursor, "MATCH", PRESENCE_PREFIX + "*", "COUNT", 100);
        cursor = String(next);
        for (const k of keys) {
          for (const m of await c.smembers(k)) union.add(String(m));
        }
      } while (cursor !== "0");
      remoteUsers.clear();
      for (const u of union) remoteUsers.add(u);
    } catch (err) {
      warnOnce(err); // 缓存保持最后已知值，下一轮重试
    }
  };
  void tick();
  timer = setInterval(tick, intervalMs);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 优雅关闭：停定时器并退出自建 Redis 连接（注入的客户端归调用方管）。 */
export async function shutdownPresence(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (client && ownsClient) {
    const c = client;
    client = null;
    ownsClient = false;
    try {
      await c.quit?.();
    } catch {
      /* ignore */
    }
  }
}

/** 测试用：清空全部模块状态（vitest 同文件多场景隔离）。 */
export function __resetPresenceForTests(): void {
  localUsers.clear();
  remoteUsers.clear();
  client = null;
  ownsClient = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  warnedKey = "";
}
