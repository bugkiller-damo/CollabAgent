import type { FastifyInstance } from "fastify";

// 用户所属的组织（server）id 列表
export async function getUserOrgIds(app: FastifyInstance, userId: string): Promise<string[]> {
  const r = await app.pg.query<{ server_id: string }>("SELECT server_id FROM server_members WHERE user_id::text = $1", [
    userId,
  ]);
  return r.rows.map((x) => String(x.server_id));
}

// 获取或创建用户的个人组织
export async function getOrCreatePersonalOrg(app: FastifyInstance, userId: string, handle?: string): Promise<string> {
  const found = await app.pg.query<{ id: string }>(
    "SELECT id FROM servers WHERE owner_id::text = $1 AND personal = true LIMIT 1",
    [userId],
  );
  if (found.rows.length > 0) return String(found.rows[0]!.id);
  const name = (handle || "我") + " 的私有空间";
  const created = await app.pg.query<{ id: string }>(
    "INSERT INTO servers (name, created_by, owner_id, personal) VALUES ($1, $2, $3, true) RETURNING id",
    [name, userId, userId],
  );
  const orgId = String(created.rows[0]!.id);
  await app.pg.query(
    "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
    [orgId, userId],
  );
  return orgId;
}

/** 是否是组织拥有者 */
export async function isOrgOwner(app: FastifyInstance, serverId: string, userId: string): Promise<boolean> {
  const r = await app.pg.query(
    "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id::text = $2 AND role = 'owner'",
    [serverId, userId],
  );
  if (r.rows.length > 0) return true;
  const s = await app.pg.query("SELECT 1 FROM servers WHERE id = $1 AND owner_id::text = $2", [serverId, userId]);
  return s.rows.length > 0;
}

/**
 * 实例级管理员判定（P1.30）：默认社区（最早非个人 server）的 owner。
 * 个人空间（personal=true，每用户自动持有）不计——否则等于全员放行，门禁失效。
 * 口径与 isOrgOwner 一致：server_members role='owner' 或 servers.owner_id 直列。
 * 2026-09-18 guild 化收紧：POST /api/orgs 放开建服后，「任一非个人 server 的
 * owner」会让每个建服用户都拿到实例 metrics 权限（全员放行）——收敛为默认
 * 社区 owner，与 index.ts 启动 bootstrap 的擢升目标同一子查询口径。
 */
export async function isInstanceAdmin(app: FastifyInstance, userId: string): Promise<boolean> {
  const r = await app.pg.query(
    `SELECT 1 FROM servers s
       LEFT JOIN server_members sm ON sm.server_id = s.id AND sm.user_id::text = $1
      WHERE s.id = (SELECT id FROM servers WHERE personal = false ORDER BY created_at ASC LIMIT 1)
        AND (s.owner_id::text = $1 OR sm.role = 'owner') LIMIT 1`,
    [userId],
  );
  return r.rows.length > 0;
}
