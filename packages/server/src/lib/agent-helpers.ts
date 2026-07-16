import type { FastifyInstance } from "fastify";
import { resolveChannel } from "./channel.js";
import { isDmTarget, resolveDmTarget, type Party } from "./dm.js";

export async function getAgent(app: FastifyInstance, agentId: string): Promise<any | null> {
  const r = await app.pg.query("SELECT id, name, display_name, avatar_url, server_id, last_seen_seq FROM agents WHERE id = $1", [agentId]);
  return r.rows[0] || null;
}

export async function agentCanAccessChannel(app: FastifyInstance, channelId: string, agentId: string): Promise<boolean> {
  const r = await app.pg.query<{ type: string }>("SELECT type FROM channels WHERE id = $1", [channelId]);
  const type = r.rows[0]?.type;
  if (type == null) return false;
  if (type !== "private" && type !== "dm") return true;
  const m = await app.pg.query(
    "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent'",
    [channelId, agentId]
  );
  return m.rows.length > 0;
}

export async function resolveAgentChannelDbId(app: FastifyInstance, agentId: string, channelArg: string): Promise<string | null> {
  if (isDmTarget(channelArg)) {
    const ag = await getAgent(app, agentId);
    const me: Party = { id: agentId, type: "agent", handle: ag?.name || "agent" };
    const r = await resolveDmTarget(app, me, channelArg);
    return r?.channelId ?? null;
  }
  const ch = await resolveChannel(app, channelArg);
  return ch?.id ?? null;
}

export async function resolveChannelByName(app: FastifyInstance, channel: string): Promise<any | null> {
  return resolveChannel(app, channel, "id, server_id");
}
