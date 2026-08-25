import {
  type AgentDuty,
  type AgentPresence,
  agentListFields,
  composePresence,
  parseAgentDuty,
} from "@collabagent/shared";
import { daemonClients, sendToDaemon, sendToUser } from "../ws/handler.js";
import { appendEvent } from "./audit.js";

export { composePresence, parseAgentDuty };

export function computerOnlineFor(userId: string): boolean {
  return daemonClients.has(String(userId));
}

export function decorateAgentPresence<T extends { user_id?: unknown; userId?: unknown; duty?: unknown }>(
  row: T,
  runtime?: string | null,
): T & { duty: AgentDuty; presence: AgentPresence; isOnline: boolean } {
  const owner = String(row.user_id ?? row.userId ?? "");
  const fields = agentListFields(row.duty as string | undefined, computerOnlineFor(owner), runtime);
  return { ...row, ...fields };
}

export function presencePayload(input: {
  agentId: string;
  agentName: string;
  duty: AgentDuty | string;
  ownerUserId: string;
  runtime?: string | null;
}): {
  type: "agent:presence";
  agentId: string;
  agentName: string;
  duty: AgentDuty;
  computerOnline: boolean;
  presence: AgentPresence;
} {
  const duty = parseAgentDuty(input.duty);
  const computerOnline = computerOnlineFor(input.ownerUserId);
  return {
    type: "agent:presence",
    agentId: input.agentId,
    agentName: input.agentName,
    duty,
    computerOnline,
    presence: composePresence(duty, computerOnline, input.runtime),
  };
}

type Queryable = {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  transaction?: <T>(fn: (tx: { query: Queryable["query"] }) => Promise<T>) => Promise<T>;
};

/** 向该 agent 所在组织的在线浏览器推 presence（People / Computer / 档案都要听到）。 */
export async function broadcastAgentPresence(
  pg: Queryable,
  input: {
    agentId: string;
    agentName: string;
    duty: AgentDuty | string;
    ownerUserId: string;
    serverId?: string | null;
    runtime?: string | null;
  },
): Promise<void> {
  const event = presencePayload(input);
  sendToUser(String(input.ownerUserId), event);
  let serverId = input.serverId;
  if (!serverId) {
    const r = await pg.query<{ server_id: string }>("SELECT server_id FROM agents WHERE id = $1", [input.agentId]);
    serverId = r.rows[0]?.server_id;
  }
  if (!serverId) return;
  try {
    const members = await pg.query<{ user_id: string }>("SELECT user_id FROM server_members WHERE server_id = $1", [
      serverId,
    ]);
    for (const m of members.rows) {
      const uid = String(m.user_id);
      if (uid === String(input.ownerUserId)) continue;
      sendToUser(uid, event);
    }
  } catch {
    /* 广播失败不挡写路径 */
  }
}

/** daemon 上下线：重算该 owner 名下全部 agent 的 presence。 */
export async function broadcastOwnerPresence(pg: Queryable | null | undefined, ownerUserId: string): Promise<void> {
  if (!pg) return;
  try {
    const rows = await pg.query<{ id: string; name: string; duty: string; server_id: string }>(
      "SELECT id, name, duty, server_id FROM agents WHERE user_id::text = $1",
      [String(ownerUserId)],
    );
    for (const a of rows.rows) {
      await broadcastAgentPresence(pg, {
        agentId: String(a.id),
        agentName: a.name,
        duty: a.duty,
        ownerUserId,
        serverId: String(a.server_id),
      });
    }
  } catch (err) {
    console.warn("[duty] broadcast owner presence failed:", (err as Error)?.message ?? err);
  }
}

export async function setAgentDuty(
  pg: Queryable & { transaction: NonNullable<Queryable["transaction"]> },
  input: { agentId: string; duty: AgentDuty; actorId: string },
): Promise<{
  id: string;
  name: string;
  user_id: string;
  server_id: string;
  duty: AgentDuty;
  presence: AgentPresence;
  computerOnline: boolean;
  isOnline: boolean;
}> {
  const row = await pg.transaction(async (tx) => {
    const updated = await tx.query<{
      id: string;
      name: string;
      user_id: string;
      server_id: string;
      duty: string;
    }>("UPDATE agents SET duty = $1, updated_at = now() WHERE id = $2 RETURNING id, name, user_id, server_id, duty", [
      input.duty,
      input.agentId,
    ]);
    const agent = updated.rows[0];
    if (!agent) return null;
    await appendEvent(tx, {
      actorId: input.actorId,
      actorType: "human",
      verb: input.duty === "on" ? "agent.duty_on" : "agent.duty_off",
      objectType: "agent",
      objectId: input.agentId,
      payload: { name: agent.name, duty: input.duty },
    });
    return agent;
  });
  if (!row) {
    const err = new Error("agent not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  const duty = parseAgentDuty(row.duty);
  const computerOnline = computerOnlineFor(String(row.user_id));
  const presence = composePresence(duty, computerOnline);
  sendToDaemon(String(row.user_id), {
    type: "agent:duty",
    agentId: String(row.id),
    name: row.name,
    duty,
  });
  await broadcastAgentPresence(pg, {
    agentId: String(row.id),
    agentName: row.name,
    duty,
    ownerUserId: String(row.user_id),
    serverId: String(row.server_id),
  });
  return {
    id: String(row.id),
    name: row.name,
    user_id: String(row.user_id),
    server_id: String(row.server_id),
    duty,
    presence,
    computerOnline,
    isOnline: presence === "idle" || presence === "starting" || presence === "working",
  };
}
