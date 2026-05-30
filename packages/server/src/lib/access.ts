import type { FastifyInstance } from "fastify";

export async function getChannelType(app: FastifyInstance, channelId: string): Promise<string | null> {
  const r = await app.pg.query("SELECT type FROM channels WHERE id = $1", [channelId]);
  return (r.rows[0] as any)?.type ?? null;
}

export async function getMemberRole(app: FastifyInstance, channelId: string, userId: string): Promise<string | null> {
  const r = await app.pg.query(
    "SELECT role FROM channel_members WHERE channel_id = $1 AND member_id::text = $2 AND member_type = 'human'",
    [channelId, userId]
  );
  return (r.rows[0] as any)?.role ?? null;
}

// 私有频道 / DM：仅成员可访问；公开频道：任何登录用户可访问
export async function canAccessChannel(app: FastifyInstance, channelId: string, userId: string): Promise<boolean> {
  const type = await getChannelType(app, channelId);
  if (type === null) return false;
  if (type !== "private" && type !== "dm") return true;
  return (await getMemberRole(app, channelId, userId)) !== null;
}

// 管理权限：owner / admin 可修改频道、管理成员
export async function canManageChannel(app: FastifyInstance, channelId: string, userId: string): Promise<boolean> {
  const role = await getMemberRole(app, channelId, userId);
  return role === "owner" || role === "admin";
}
