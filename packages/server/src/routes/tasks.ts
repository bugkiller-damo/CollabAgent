import type { FastifyInstance } from "fastify";
import { canAccessChannel } from "../lib/access.js";
import { cleanChannelName, resolveChannel } from "../lib/channel.js";

const STATUSES = ["todo", "in_progress", "in_review", "done", "closed"];

export async function taskRoutes(app: FastifyInstance) {
  // 解析频道并校验调用者可见性（公开频道任何人可读；私有/DM 仅成员）。
  // 返回 null 表示已发 404/403，调用方直接 return。
  async function resolveAccessible(channel: string, userId: string, reply: any, cols = "id") {
    const ch = await resolveChannel(app, channel, cols);
    if (!ch) {
      reply.status(404).send({ error: "channel not found" });
      return null;
    }
    if (!(await canAccessChannel(app, ch.id, userId))) {
      reply.status(403).send({ error: "no access to this channel" });
      return null;
    }
    return ch;
  }

  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, status } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveAccessible(channel, req.user.sub, reply);
    if (!ch) return;
    const chId = ch.id;
    let query = `SELECT m.id, m.content, m.task_number, m.task_status, m.task_assignee, m.created_at,
                        COALESCE(au.handle, aa.name) as assignee_handle,
                        COALESCE(su.display_name, su.handle, sa.display_name, sa.name, 'User') as creator_name
                 FROM messages m
                 LEFT JOIN users au ON m.task_assignee = au.id
                 LEFT JOIN agents aa ON m.task_assignee = aa.id
                 LEFT JOIN users su ON m.sender_id = su.id
                 LEFT JOIN agents sa ON m.sender_id = sa.id
                 WHERE m.channel_id = $1 AND m.task_number IS NOT NULL`;
    const params: any[] = [chId];
    if (status && status !== "all") {
      params.push(status);
      query += ` AND m.task_status = $${params.length}`;
    }
    query += " ORDER BY m.task_number ASC";
    const result = await app.pg.query(query, params);
    return { tasks: result.rows };
  });

  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, tasks } = req.body as { channel?: string; tasks?: { title: string }[] };
    if (!channel || !tasks?.length) return reply.status(400).send({ error: "channel and tasks required" });
    const ch = await resolveAccessible(channel, req.user.sub, reply, "id, server_id");
    if (!ch) return;
    const userId = req.user.sub;
    const maxNum = await app.pg.query<{ n: number }>(
      "SELECT COALESCE(MAX(task_number), 0) as n FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL",
      [ch.id],
    );
    let next = Number(maxNum.rows[0]!.n);
    const created: any[] = [];
    for (const t of tasks) {
      next++;
      const result = await app.pg.query(
        `INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, task_number, task_status)
         VALUES ($1, $2, $3, 'human', $4, $5, 'todo') RETURNING id, task_number, content`,
        [ch.id, ch.server_id, userId, t.title, next],
      );
      created.push(result.rows[0]);
    }
    return { tasks: created };
  });

  // 已有消息 → 任务：给消息行补 task_number（单条原子 UPDATE 取号，避免并发重号）
  app.post("/from-message", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { message_id } = req.body as { message_id?: string };
    if (!message_id) return reply.status(400).send({ error: "message_id required" });
    const found = await app.pg.query<{
      id: string;
      channel_id: string;
      task_number: number | null;
      content: string | null;
    }>("SELECT id, channel_id, task_number, content FROM messages WHERE id = $1", [message_id]);
    const msg = found.rows[0];
    if (!msg) return reply.status(404).send({ error: "message not found" });
    if (!(await canAccessChannel(app, msg.channel_id, req.user.sub))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    if (msg.task_number != null) {
      return reply.status(409).send({ error: "message is already a task", task_number: msg.task_number });
    }
    if (!msg.content) return reply.status(400).send({ error: "cannot convert a deleted message" });
    const result = await app.pg.query(
      `UPDATE messages
         SET task_number = (SELECT COALESCE(MAX(task_number), 0) + 1 FROM messages
                            WHERE channel_id = $2 AND task_number IS NOT NULL),
             task_status = 'todo', updated_at = now()
       WHERE id = $1 AND task_number IS NULL
       RETURNING id, task_number, task_status, content`,
      [message_id, msg.channel_id],
    );
    if (result.rows.length === 0) {
      return reply.status(409).send({ error: "message is already a task" });
    }
    return { task: result.rows[0] };
  });

  app.post("/claim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, task_numbers, message_ids } = req.body as {
      channel?: string;
      task_numbers?: number[];
      message_ids?: string[];
    };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveAccessible(channel, req.user.sub, reply);
    if (!ch) return;
    const chId = ch.id;
    const userId = req.user.sub;
    const results: any[] = [];
    for (const num of task_numbers || []) {
      const existing = await app.pg.query("SELECT * FROM messages WHERE channel_id = $1 AND task_number = $2", [
        chId,
        num,
      ]);
      if (existing.rows.length === 0) {
        results.push({ number: num, status: "conflict", error: "not_found" });
        continue;
      }
      const msg = existing.rows[0];
      if (msg.task_status === "done" || msg.task_status === "closed") {
        results.push({ number: num, status: "conflict", error: "task_is_done" });
        continue;
      }
      if (msg.task_assignee && msg.task_assignee !== userId) {
        results.push({ number: num, status: "conflict", error: "already_claimed_by_other" });
        continue;
      }
      await app.pg.query(
        "UPDATE messages SET task_status = 'in_progress', task_assignee = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3",
        [userId, chId, num],
      );
      results.push({ number: num, status: "claimed" });
    }
    return { results };
  });

  app.post("/unclaim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, task_number } = req.body as { channel?: string; task_number?: number };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveAccessible(channel, req.user.sub, reply);
    if (!ch) return;
    await app.pg.query(
      "UPDATE messages SET task_assignee = NULL, task_status = 'todo', updated_at = now() WHERE channel_id = $1 AND task_number = $2",
      [ch.id, task_number],
    );
    return { ok: true };
  });

  app.post("/update-status", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, number, status } = req.body as { channel?: string; number?: number; status?: string };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    if (!status || !STATUSES.includes(status)) return reply.status(400).send({ error: `invalid status: ${status}` });
    const ch = await resolveAccessible(channel, req.user.sub, reply);
    if (!ch) return;
    const chId = ch.id;
    const result = await app.pg.query(
      "UPDATE messages SET task_status = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3 RETURNING *",
      [status, chId, number],
    );
    // 任务完成/关闭时通知创建者（仅人类创建者有通知中心；agent 创建的跳过，
    // 否则 notifications.user_id 外键指向 users 表会因 agent id 违约导致 500。
    // 通知失败不阻断状态更新本身。）
    if (
      result.rows.length > 0 &&
      (status === "done" || status === "closed") &&
      result.rows[0].sender_type === "human"
    ) {
      try {
        const task = result.rows[0];
        const { createNotification } = await import("../lib/notifications.js");
        const channelResult = await app.pg.query("SELECT name FROM channels WHERE id = $1", [chId]);
        const channelName = channelResult.rows[0]?.name || channel;
        await createNotification(app, {
          userId: String(task.sender_id),
          type: "task_assigned",
          actorId: String(req.user.sub),
          actorName: String(req.user?.handle ?? "unknown"),
          channelId: String(chId),
          title: `任务 #${number} 已完成`,
          body: String(task.content || "").slice(0, 200),
          metadata: { channelName, taskNumber: number, newStatus: status },
        });
      } catch (err) {
        req.log.warn({ err }, "task completion notification failed");
      }
    }
    return { ok: true, task: result.rows[0] };
  });
}
