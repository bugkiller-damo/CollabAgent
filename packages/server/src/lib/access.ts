import type { FastifyInstance } from "fastify";
import type { PubSub } from "./pubsub.js";
import { isServerMember } from "./tenant.js";

/**
 * O7 权限缓存一致性。
 *
 * 权限查询结果（频道类型 / 成员角色）带 TTL 缓存，降低每次请求的 DB 往返。
 * 一致性语义（明确记录）：
 * - 变更点主动失效：成员增删/角色变更/频道类型变更处调用 invalidateChannel /
 *   invalidateMember，本地缓存立即清除——变更后**下一次**权限判定即为新值，
 *   不存在最长 2s 的旧权限窗口；
 * - 跨实例失效：setAccessPubSub 注入 O1 的 pub/sub 后，失效消息经
 *   `slock:access-inv:v1` 扇出，其它实例同步清除本地缓存（多实例一致）；
 * - TTL 兜底：某实例宕机/网络分区错过失效消息时，缓存最迟 ACCESS_CACHE_TTL_MS
 *   后过期——一致性窗口始终有界；
 * - 未注入 pub/sub（单测/未接线）时失效仅作用于本进程，仍满足单实例语义。
 */

/** 权限缓存 TTL（毫秒）：主动失效之外的兜底过期窗口。 */
export const ACCESS_CACHE_TTL_MS = 2000;
/** 后台清扫周期（毫秒）：惰性过期条目在此节奏内被回收。 */
const ACCESS_CACHE_SWEEP_MS = 10_000;

const cache = new Map<string, { value: any; expiresAt: number }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const e = cache.get(key);
  if (e && Date.now() < e.expiresAt) return e.value as T;
  const v = await fn();
  cache.set(key, { value: v, expiresAt: Date.now() + ACCESS_CACHE_TTL_MS });
  return v;
}

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of cache) if (v.expiresAt < n) cache.delete(k);
}, ACCESS_CACHE_SWEEP_MS);

/** 按精确前缀清缓存条目（供失效与测试使用）。 */
function clearByPrefix(prefix: string): void {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

// ---------- 主动失效（O7） ----------

/** 失效某频道的类型/归属信息缓存（频道类型变更、删除等）。 */
export function invalidateChannel(channelId: string): void {
  clearByPrefix(`c:${channelId}`);
  publishAccessInvalidation({ kind: "channel", channelId });
}

/** 失效某频道的成员角色缓存；不传 userId 时清整个频道的全部成员条目。 */
export function invalidateMember(channelId: string, userId?: string): void {
  clearByPrefix(userId ? `r:${channelId}:${userId}` : `r:${channelId}:`);
  publishAccessInvalidation({ kind: "member", channelId, userId });
}

const ACCESS_INV_CHANNEL = "slock:access-inv:v1";

interface AccessInvalidation {
  kind: "channel" | "member";
  channelId?: string;
  userId?: string;
}

let accessPubSub: PubSub | null = null;

/** 注入 pub/sub（index.ts 启动时调用）：订阅远端失效消息，清除本实例缓存。 */
export function setAccessPubSub(pubsub: PubSub): void {
  accessPubSub = pubsub;
  pubsub.subscribe(ACCESS_INV_CHANNEL, (payload) => {
    const p = payload as AccessInvalidation;
    if (!p || typeof p.channelId !== "string") return;
    if (p.kind === "channel") {
      clearByPrefix(`c:${p.channelId}`);
    } else if (p.kind === "member") {
      clearByPrefix(p.userId ? `r:${p.channelId}:${p.userId}` : `r:${p.channelId}:`);
    }
  });
}

/** 失效扇出：本地订阅者立即处理（publish 本地直投），远端实例经 Redis 收到。 */
function publishAccessInvalidation(payload: AccessInvalidation): void {
  try {
    accessPubSub?.publish(ACCESS_INV_CHANNEL, payload);
  } catch {
    /* 失效扇出失败不阻断业务变更；TTL 兜底 */
  }
}

// ---------- 查询 ----------

interface ChannelInfo {
  server_id: string;
  type: string;
}

function getChannelInfo(app: FastifyInstance, channelId: string): Promise<ChannelInfo | null> {
  return cached(`c:${channelId}`, async () => {
    const r = await app.pg.query<{ server_id: string; type: string }>(
      "SELECT server_id, type FROM channels WHERE id = $1",
      [channelId],
    );
    return r.rows[0] || null;
  });
}

export async function getChannelType(app: FastifyInstance, channelId: string): Promise<string | null> {
  const info = await getChannelInfo(app, channelId);
  return info?.type ?? null;
}

export async function getMemberRole(app: FastifyInstance, channelId: string, userId: string): Promise<string | null> {
  return cached(`r:${channelId}:${userId}`, async () => {
    const r = await app.pg.query<{ role: string }>(
      "SELECT role FROM channel_members WHERE channel_id = $1 AND member_id::text = $2 AND member_type = 'human'",
      [channelId, userId],
    );
    return r.rows[0]?.role ?? null;
  });
}

export interface ChannelAccessOptions {
  /**
   * 请求租户 serverId（O3）。非 dm 频道必须属于该 server——跨社区同名/同 ID
   * 混淆时 fail-closed（403 而不是串数据）。默认 undefined = 不校验（单租户降级）。
   */
  serverId?: string | null;
  /**
   * 显式租户下把「公开频道任何登录用户可读」收紧为「必须同时是频道所在 server
   * 的成员」。单租户降级（默认）保持既有行为，避免存量部署被破坏。
   */
  enforceServerMembership?: boolean;
}

export async function canAccessChannel(
  app: FastifyInstance,
  channelId: string,
  userId: string,
  opts: ChannelAccessOptions = {},
): Promise<boolean> {
  const info = await getChannelInfo(app, channelId);
  if (!info) return false;
  const { server_id, type } = info;
  // DM 频道跨社区存在（双方成员制），不套 server 作用域
  if (type !== "dm" && opts.serverId && String(server_id) !== String(opts.serverId)) return false;
  if (type === "private" || type === "dm") {
    if ((await getMemberRole(app, channelId, userId)) === null) return false;
  } else if (opts.enforceServerMembership) {
    if (!(await isServerMember(app, String(server_id), userId))) return false;
  }
  return true;
}

export async function canManageChannel(app: FastifyInstance, channelId: string, userId: string): Promise<boolean> {
  const role = await getMemberRole(app, channelId, userId);
  return role === "owner" || role === "admin";
}
