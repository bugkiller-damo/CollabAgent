import type { FastifyInstance } from "fastify";
import { sendToUser } from "../ws/handler.js";

const NOTIFICATION_FIELDS =
  "id, user_id, type, actor_id, actor_name, channel_id, message_id, title, body, metadata, read, created_at";

export async function notificationRoutes(app: FastifyInstance) {
  // ---- 获取通知列表 ----
  app.get("/api/notifications", { preHandler: [app.authenticate] }, async (req: any) => {
    const userId = req.user.sub;
    const { limit, offset, unreadOnly } = req.query as Record<string, string | undefined>;
    const lim = Math.min(Math.max(parseInt(limit || "50", 10) || 50, 1), 100);
    const off = parseInt(offset || "0", 10) || 0;

    let query = `SELECT ${NOTIFICATION_FIELDS} FROM notifications WHERE user_id = $1`;
    const params: unknown[] = [userId];
    if (unreadOnly === "true") {
      query += " AND read = false";
    }
    query += " ORDER BY created_at DESC LIMIT $" + (params.length + 1) + " OFFSET $" + (params.length + 2);
    params.push(lim, off);

    const result = await app.pg.query(query, params);
    const unreadResult = await app.pg.query(
      "SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read = false",
      [userId],
    );

    return {
      notifications: result.rows,
      unreadCount: unreadResult.rows[0].count,
      hasMore: result.rows.length >= lim,
    };
  });

  // ---- 标记单条已读 ----
  app.patch("/api/notifications/:id/read", { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    const userId = req.user.sub;
    const { id } = req.params as { id: string };
    const result = await app.pg.query(
      "UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, userId],
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: "notification not found" });
    // P1.25：已读广播——该用户全部浏览器连接同步（发起端已乐观更新，幂等套用）
    sendToUser(userId, { type: "notification.read", ids: [id], all: false });
    return { ok: true };
  });

  // ---- 批量标记已读 ----
  app.patch("/api/notifications/read", { preHandler: [app.authenticate] }, async (req: any) => {
    const userId = req.user.sub;
    const { ids } = req.body as { ids?: string[] };
    if (ids && Array.isArray(ids) && ids.length > 0) {
      await app.pg.query("UPDATE notifications SET read = true WHERE id = ANY($1::uuid[]) AND user_id = $2", [
        ids,
        userId,
      ]);
      // P1.25：已读广播（批量 ids 面）——只广播本次请求携带的 id
      sendToUser(userId, {
        type: "notification.read",
        ids: ids.filter((x): x is string => typeof x === "string"),
        all: false,
      });
    } else {
      await app.pg.query("UPDATE notifications SET read = true WHERE user_id = $1", [userId]);
      // P1.25：已读广播（全部面）——all=true 语义，消费端直接套「全部已读」
      sendToUser(userId, { type: "notification.read", ids: null, all: true });
    }
    return { ok: true };
  });

  // ---- 未读计数 ----
  app.get("/api/notifications/unread-count", { preHandler: [app.authenticate] }, async (req: any) => {
    const userId = req.user.sub;
    const result = await app.pg.query(
      "SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read = false",
      [userId],
    );
    return { unreadCount: result.rows[0].count };
  });
}
