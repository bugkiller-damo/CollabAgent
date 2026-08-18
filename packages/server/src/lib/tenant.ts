import type { FastifyInstance, FastifyRequest } from "fastify";
import { getDefaultServerId } from "./server.js";

/**
 * 请求级租户解析（O3 多租户边界）。
 *
 * 租户 = server（社区/组织）。解析优先级：
 *   1. 显式 serverId 参数（query/body 由调用路由传入）；
 *   2. `x-server-id` header（跨端显式声明，如嵌入不同社区的客户端）；
 *   3. Host header 命中 `SERVER_HOST_MAP`（"URL 即社区"，对齐 Buzz 的 relay URL 约定）；
 *   4. 降级：单租户部署的默认 server（getDefaultServerId）。
 *
 * 前三种是「显式租户」：调用方声明了自己要访问哪个社区，路由必须用
 * isServerMember 校验调用者归属，否则任意 serverId 可枚举他人组织的频道/成员。
 * 第 4 种是单租户降级（explicit=false），保持既有行为不变，多社区托管开启后
 * 该路径仅剩「未配置 Host 映射」时的兜底。
 */

export const TENANT_HEADER = "x-server-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantSource = "param" | "header" | "host" | "default" | "none";

export interface TenantContext {
  /** 解析到的 serverId；显式租户给出非法 UUID 或空库时为 null */
  serverId: string | null;
  /** 租户是否由调用方显式指定（param/header/host）——explicit 时路由必须校验成员身份 */
  explicit: boolean;
  source: TenantSource;
}

/**
 * 解析 SERVER_HOST_MAP（`host1.example.com=<uuid>, host2=<uuid>`）。
 * 纯函数，可单测。非法条目（host 为空 / serverId 非 UUID）跳过；空/缺失返回空 Map。
 */
export function parseHostMap(raw: string | undefined | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || !raw.trim()) return map;
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const host = entry.slice(0, eq).trim().toLowerCase();
    const serverId = entry.slice(eq + 1).trim();
    if (!host || !UUID_RE.test(serverId)) continue;
    map.set(host, serverId);
  }
  return map;
}

/** 按 Host header（忽略端口、大小写与末尾点）在 host map 中查找 serverId。纯函数，可单测。 */
export function resolveHostServerId(hostMap: Map<string, string>, hostHeader?: string): string | null {
  if (!hostHeader) return null;
  const clean = String(hostHeader)
    .split(",")[0] // 多值 Host 取第一个
    .trim()
    .toLowerCase()
    .replace(/\.+$/, ""); // 去尾随点
  if (!clean) return null;
  // 先全量匹配，再剥端口匹配（"host:port" → "host"）
  if (hostMap.has(clean)) return hostMap.get(clean) ?? null;
  const idx = clean.lastIndexOf(":");
  if (idx > 0) {
    const noPort = clean.slice(0, idx);
    if (hostMap.has(noPort)) return hostMap.get(noPort) ?? null;
  }
  return null;
}

/** 进程级 host→server 映射（SERVER_HOST_MAP env），惰性解析并缓存。 */
let hostMapCache: Map<string, string> | null = null;
export function getTenantHostMap(): Map<string, string> {
  if (hostMapCache === null) hostMapCache = parseHostMap(process.env.SERVER_HOST_MAP);
  return hostMapCache;
}

/** 测试辅助：重置 host map 缓存（配合动态 env 单测）。 */
export function resetTenantHostMapCache(): void {
  hostMapCache = null;
}

/** 调用者是否是某 server（社区）成员。 */
export async function isServerMember(
  app: FastifyInstance,
  serverId: string | null | undefined,
  userId: string,
): Promise<boolean> {
  if (!serverId) return false;
  const r = await app.pg.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2 LIMIT 1", [
    serverId,
    userId,
  ]);
  return r.rows.length > 0;
}

function firstHeaderValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

/**
 * 请求级租户解析。返回 TenantContext；不做成员校验（由路由按 explicit 决定是否
 * 调用 isServerMember —— 显式租户必须校验，默认降级保持单租户既有行为）。
 */
export async function resolveTenant(
  app: FastifyInstance,
  request: FastifyRequest,
  opts?: { serverId?: string | null | undefined },
): Promise<TenantContext> {
  const param = opts?.serverId ? String(opts.serverId).trim() : "";
  if (param) {
    // O3 兼容豁免：单租户部署（未配置 SERVER_HOST_MAP）下，显式声明「默认 server」
    // 与不声明走降级等价。前端 store 会把 /api/server/info 返回的默认 server id 原样
    // 回传（web 的 channelStore 建频道），而注册并不自动加入默认 server——
    // 若强制成员校验会把存量前端的建频道打成 403。默认社区本就是开放社区（公开频道
    // 对全体登录用户可见），豁免不增加暴露面。多租户部署（配置了 host 映射）不豁免。
    const fallback = await getDefaultServerId(app);
    if (getTenantHostMap().size === 0 && fallback && param === fallback) {
      return { serverId: fallback, explicit: false, source: "default" };
    }
    return { serverId: UUID_RE.test(param) ? param : null, explicit: true, source: "param" };
  }
  const header = firstHeaderValue(request.headers?.[TENANT_HEADER]).trim();
  if (header) {
    const id = header.split(",")[0].trim(); // 多值头取第一个
    return { serverId: UUID_RE.test(id) ? id : null, explicit: true, source: "header" };
  }
  const host = resolveHostServerId(getTenantHostMap(), firstHeaderValue(request.headers?.host));
  if (host) return { serverId: host, explicit: true, source: "host" };
  const fallback = await getDefaultServerId(app);
  return { serverId: fallback, explicit: false, source: fallback ? "default" : "none" };
}
