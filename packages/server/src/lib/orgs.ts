import type { FastifyInstance } from "fastify";

// 用户所属的组织（server）id 列表
export async function getUserOrgIds(app: FastifyInstance, userId: string): Promise<string[]> {
  const r = await app.pg.query("SELECT server_id FROM server_members WHERE user_id::text = $1", [userId]);
  return (r.rows as any[]).map((x) => String(x.server_id));
}

// 获取或创建用户的个人组织（私有空间）。新建 agent 默认落在这里 → 仅本人可见，直到把别人加进来。
export async function getOrCreatePersonalOrg(app: FastifyInstance, userId: string, handle?: string): Promise<string> {
  const found = await app.pg.query(
    "SELECT id FROM servers WHERE owner_id::text = $1 AND personal = true LIMIT 1",
    [userId]
  );
  if (found.rows.length > 0) return String((found.rows[0] as any).id);
  const name = (handle || "我") + " 的私有空间";
  const created = await app.pg.query(
    "INSERT INTO servers (name, created_by, owner_id, personal) VALUES ($1, $2, $3, true) RETURNING id",
    [name, userId, userId]
  );
  const orgId = String((created.rows[0] as any).id);
  await app.pg.query(
    "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
    [orgId, userId]
  );
  return orgId;
}

/** dev-token 在 DB 中对应的固定测试用户 ID（仅 dev 模式使用） */
export const DEV_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEV_USER_HANDLE = "dev-user";

/**
 * 确保 dev-user 在 users 表中存在（dev 模式首次访问自动创建）
 */
export async function ensureDevUser(app: FastifyInstance): Promise<string> {
  const r = await app.pg.query("SELECT id FROM users WHERE id::text = $1", [DEV_USER_ID]);
  if (r.rows.length > 0) return DEV_USER_ID;
  await app.pg.query(
    `INSERT INTO users (id, handle, display_name, password_hash) VALUES ($1, $2, $3, '') ON CONFLICT (id) DO NOTHING`,
    [DEV_USER_ID, DEV_USER_HANDLE, "Dev User"]
  );
  return DEV_USER_ID;
}

/**
 * 解析请求用户上下文 — 替代路由中的硬编码
 * - dev-user → 自动创建 dev 测试用户 + 个人组织，返回固定 ID
 * - 真实用户 → 返回其个人组织（不存在则创建）
 */
export interface ResolvedUserContext {
  userId: string;
  subsidiaryId: string;
}

export async function resolveUserContext(app: FastifyInstance, userId: string, handle?: string): Promise<ResolvedUserContext> {
  const realUserId = userId === "dev-user" ? await ensureDevUser(app) : userId;
  const subsidiaryId = await getOrCreatePersonalOrg(app, realUserId, handle);
  return { userId: realUserId, subsidiaryId };
}
