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
