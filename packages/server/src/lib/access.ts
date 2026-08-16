import type { FastifyInstance } from "fastify";
import { isServerMember } from "./tenant.js";

const cache = new Map<string, { value: any; expiresAt: number }>();
const TTL = 2000;

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const e = cache.get(key);
  if (e && Date.now() < e.expiresAt) return e.value as T;
  const v = await fn();
  cache.set(key, { value: v, expiresAt: Date.now() + TTL });
  return v;
}

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of cache) if (v.expiresAt < n) cache.delete(k);
}, 10_000);

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
