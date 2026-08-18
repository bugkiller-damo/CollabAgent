import type { FastifyInstance } from "fastify";
import { canAccessChannel } from "../lib/access.js";
import { type ActorType, eventHash } from "../lib/audit.js";

/**
 * 审计 API（O2）：查询不可变事件流水 + 校验哈希链完整性。
 *
 * - GET /api/audit        按 object_type/object_id/verb 查询事件（按 id 升序，即时间序）；
 * - GET /api/audit/verify 校验目标对象事件所在哈希链是否完整（tamper-evident）。
 *
 * 访问控制：调用方必须能访问被审计对象。当前仅实现 message 对象的可见性校验
 * （复用频道可见性），其余 object_type 一律 403 fail-closed，待对应对象接入后再放开。
 */

/** 查询/校验前先确认调用方可访问目标对象。返回 403 则无权。 */
async function assertObjectAccess(
  app: FastifyInstance,
  objectType: string,
  objectId: string,
  userId: string,
): Promise<"ok" | "forbidden" | "notfound"> {
  if (objectType === "message") {
    const m = await app.pg.query<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = $1", [objectId]);
    if (m.rows.length === 0) return "notfound";
    if (await canAccessChannel(app, String(m.rows[0].channel_id), userId)) return "ok";
    return "forbidden";
  }
  if (objectType === "agent") {
    // agent 对象（C1 工具调用审计流：verb=tool.call.start/end）：
    // 可见性 = 「agent 属于当前用户」（agents.user_id 即 daemon 所有者）
    const a = await app.pg.query<{ user_id: string }>("SELECT user_id FROM agents WHERE id = $1", [objectId]);
    if (a.rows.length === 0) return "notfound";
    if (String(a.rows[0].user_id) === userId) return "ok";
    return "forbidden";
  }
  // 其余对象类型尚未接入可见性判定，一律拒绝（避免越权枚举）
  return "forbidden";
}

const SELECT_EVENTS =
  "SELECT id, actor_id, actor_type, verb, object_type, object_id, payload, prev_hash, hash, created_at FROM events";

export async function auditRoutes(app: FastifyInstance) {
  app.get("/audit", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { object_type, object_id, verb, limit, before_id } = req.query as Record<string, string | undefined>;
    if (!object_type || !object_id) {
      return reply.status(400).send({ error: "object_type and object_id are required" });
    }
    const userId = String(req.user.sub);
    const access = await assertObjectAccess(app, object_type, object_id, userId);
    if (access === "forbidden") return reply.status(403).send({ error: "no access to this object" });
    if (access === "notfound") return reply.status(404).send({ error: "object not found" });

    const params: (string | number)[] = [object_type, object_id];
    let where = "WHERE object_type = $1 AND object_id = $2";
    let p = 3;
    if (verb) {
      where += ` AND verb = $${p++}`;
      params.push(verb);
    }
    if (before_id) {
      where += ` AND id < $${p++}`;
      params.push(Number(before_id));
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    where += ` ORDER BY id ASC LIMIT $${p}`;
    params.push(lim);

    const r = await app.pg.query(`${SELECT_EVENTS} ${where}`, params);
    return { events: r.rows, count: r.rows.length };
  });

  app.get("/audit/verify", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { object_type, object_id } = req.query as Record<string, string | undefined>;
    if (!object_type || !object_id) {
      return reply.status(400).send({ error: "object_type and object_id are required" });
    }
    const userId = String(req.user.sub);
    const access = await assertObjectAccess(app, object_type, object_id, userId);
    if (access === "forbidden") return reply.status(403).send({ error: "no access to this object" });
    if (access === "notfound") return reply.status(404).send({ error: "object not found" });

    const r = await app.pg.query<{
      id: string | number;
      actor_id: string;
      actor_type: string;
      verb: string;
      object_type: string;
      object_id: string;
      payload: Record<string, unknown>;
      prev_hash: string | null;
      hash: string;
    }>(`${SELECT_EVENTS} WHERE object_type = $1 AND object_id = $2 ORDER BY id ASC`, [object_type, object_id]);
    if (r.rows.length === 0) return { valid: true, count: 0, note: "no events for this object" };

    // 哈希链是全局链：本对象第一条事件的前一条（id < firstId 的最近一条）作为锚点 prev_hash。
    const firstId = Number(r.rows[0].id);
    const anchor = await app.pg.query<{ hash: string }>(
      "SELECT hash FROM events WHERE id < $1 ORDER BY id DESC LIMIT 1",
      [firstId],
    );
    let prev = anchor.rows[0]?.hash ?? null;
    for (const row of r.rows) {
      const expected = eventHash(
        {
          actorId: row.actor_id,
          actorType: row.actor_type as ActorType,
          verb: row.verb,
          objectType: row.object_type,
          objectId: row.object_id,
          payload: row.payload ?? {},
        },
        prev,
      );
      if (expected !== row.hash) {
        return { valid: false, brokenAt: Number(row.id), count: r.rows.length };
      }
      prev = row.hash;
    }
    return {
      valid: true,
      count: r.rows.length,
      verifiedFrom: firstId,
      verifiedTo: Number(r.rows[r.rows.length - 1].id),
    };
  });
}
