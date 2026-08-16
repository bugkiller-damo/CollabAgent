import type { FastifyInstance } from "fastify";

/**
 * 去除频道名前导 "#" 和线程后缀 ":shortId"，返回纯名称。
 * 输入 "#general:abc123" → "general"
 * 输入 "dm:@user" → "dm:@user"（不做 DM 处理）
 */
export function cleanChannelName(raw: string): string {
  if (!raw) return raw;
  const noHash = raw.startsWith("#") ? raw.slice(1) : raw;
  return noHash.split(":")[0];
}

export interface ChannelRow {
  id: string;
  server_id?: string;
  name?: string;
  description?: string;
  type?: string;
  archived?: boolean;
  [key: string]: unknown;
}

/**
 * 解析频道名（支持 "#general"、"general"、"#general:abc"）→ { id, ... }
 * 找不到返回 null。
 *
 * serverId（可选）：多租户作用域——频道名只在 server 内唯一（idx_channels_server_name），
 * 显式租户下必须带 serverId 解析，否则同名频道会跨社区串号（O3）。
 */
export async function resolveChannel(
  app: FastifyInstance,
  rawName: string,
  fields = "id",
  serverId?: string | null,
): Promise<ChannelRow | null> {
  const name = cleanChannelName(rawName);
  if (!name) return null;
  const r = serverId
    ? await app.pg.query(`SELECT ${fields} FROM channels WHERE name = $1 AND server_id = $2 LIMIT 1`, [name, serverId])
    : await app.pg.query(`SELECT ${fields} FROM channels WHERE name = $1 LIMIT 1`, [name]);
  return (r.rows[0] as ChannelRow) || null;
}

/**
 * 解析频道名 → 频道 id
 */
export async function resolveChannelId(
  app: FastifyInstance,
  rawName: string,
  serverId?: string | null,
): Promise<string | null> {
  const ch = await resolveChannel(app, rawName, "id", serverId);
  return ch?.id ?? null;
}
