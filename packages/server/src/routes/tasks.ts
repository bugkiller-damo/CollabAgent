import type { FastifyInstance } from "fastify";
import { canAccessChannel } from "../lib/access.js";
import { resolveChannel } from "../lib/channel.js";
import { syncDispatchOnCardClose } from "../lib/dispatch-sync.js";
import { recordTaskEvent, resolveMemberName } from "../lib/task-events.js";
import { acquireTaskNumberLock } from "../lib/task-numbering.js";
import { resolveTenant } from "../lib/tenant.js";

const STATUSES = ["todo", "in_progress", "in_review", "done", "closed"];

export async function taskRoutes(app: FastifyInstance) {
  // 解析频道并校验调用者可见性（公开频道任何人可读；私有/DM 仅成员）。
  // O3：显式租户下频道必须属于租户 server 且调用者是该 server 成员。
  // 返回 null 表示已发 404/403，调用方直接 return。
  async function resolveAccessible(req: any, channel: string, userId: string, reply: any, cols = "id") {
    const tenant = await resolveTenant(app, req);
    const scope = tenant.explicit ? tenant.serverId : undefined;
    const ch = await resolveChannel(app, channel, cols, scope);
    if (!ch) {
      reply.status(404).send({ error: "channel not found" });
      return null;
    }
    if (
      !(await canAccessChannel(app, ch.id, userId, {
        serverId: tenant.explicit ? tenant.serverId : undefined,
        enforceServerMembership: tenant.explicit,
      }))
    ) {
      reply.status(403).send({ error: "no access to this channel" });
      return null;
    }
    return ch;
  }

  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, status } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveAccessible(req, channel, req.user.sub, reply);
    if (!ch) return;
    const chId = ch.id;
    let query = `SELECT m.id, m.content, m.task_number, m.task_status, m.task_assignee, m.created_at,
                        m.sender_id, m.sender_type,
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
    const ch = await resolveAccessible(req, channel, req.user.sub, reply, "id, server_id");
    if (!ch) return;
    const userId = req.user.sub;
    // P0.5：取号持频道级 advisory lock 串行化，锁内读 MAX + 连续 INSERT，防并发重号
    const created: { id: string; task_number: number; content: string }[] = await app.pg.transaction(async (tx) => {
      await acquireTaskNumberLock(tx, ch.id);
      const maxNum = await tx.query<{ n: number }>(
        "SELECT COALESCE(MAX(task_number), 0) as n FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL",
        [ch.id],
      );
      let next = Number(maxNum.rows[0]!.n);
      const rows: { id: string; task_number: number; content: string }[] = [];
      for (const t of tasks) {
        next++;
        const result = await tx.query<{ id: string; task_number: number; content: string }>(
          `INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, task_number, task_status)
           VALUES ($1, $2, $3, 'human', $4, $5, 'todo') RETURNING id, task_number, content`,
          [ch.id, ch.server_id, userId, t.title, next],
        );
        rows.push(result.rows[0]!);
      }
      return rows;
    });
    for (const row of created) {
      await recordTaskEvent(app, {
        messageId: row.id,
        channelId: ch.id,
        taskNumber: row.task_number,
        actorId: userId,
        action: "created",
        toStatus: "todo",
      });
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
    const tenant = await resolveTenant(app, req);
    if (
      !(await canAccessChannel(app, msg.channel_id, req.user.sub, {
        serverId: tenant.explicit ? tenant.serverId : undefined,
        enforceServerMembership: tenant.explicit,
      }))
    ) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    if (msg.task_number != null) {
      return reply.status(409).send({ error: "message is already a task", task_number: msg.task_number });
    }
    if (!msg.content) return reply.status(400).send({ error: "cannot convert a deleted message" });
    // P0.5：取号持频道级 advisory lock——单语句 UPDATE 的 MAX+1 子查询在 READ
    // COMMITTED 并发下仍会重号（各写不同行、行锁不互斥）
    const result = await app.pg.transaction(async (tx) => {
      await acquireTaskNumberLock(tx, msg.channel_id);
      return tx.query<{ id: string; task_number: number; task_status: string; content: string }>(
        `UPDATE messages
           SET task_number = (SELECT COALESCE(MAX(task_number), 0) + 1 FROM messages
                              WHERE channel_id = $2 AND task_number IS NOT NULL),
               task_status = 'todo', updated_at = now()
         WHERE id = $1 AND task_number IS NULL
         RETURNING id, task_number, task_status, content`,
        [message_id, msg.channel_id],
      );
    });
    if (result.rows.length === 0) {
      return reply.status(409).send({ error: "message is already a task" });
    }
    await recordTaskEvent(app, {
      messageId: message_id,
      channelId: msg.channel_id,
      taskNumber: result.rows[0].task_number,
      actorId: req.user.sub,
      action: "created",
      toStatus: "todo",
      detail: "from-message",
    });
    return { task: result.rows[0] };
  });

  app.post("/claim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, task_numbers, message_ids } = req.body as {
      channel?: string;
      task_numbers?: number[];
      message_ids?: string[];
    };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveAccessible(req, channel, req.user.sub, reply);
    if (!ch) return;
    const chId = ch.id;
    const userId = req.user.sub;
    const results: any[] = [];
    for (const num of task_numbers || []) {
      // P0.5：claim 改条件更新——WHERE 带非终态 + 无人认领（或本人）条件，
      // 并发双 claim 只有一个 UPDATE 匹配成功，不再先读后写（读到的旧值会失效）
      const upd = await app.pg.query<{ id: string; old_status: string | null }>(
        `UPDATE messages m
           SET task_status = 'in_progress', task_assignee = $1, updated_at = now()
         FROM (SELECT id, task_status AS old_status FROM messages
                WHERE channel_id = $2 AND task_number = $3 AND task_number IS NOT NULL) old
         WHERE m.id = old.id
           AND (m.task_status IS NULL OR m.task_status NOT IN ('done', 'closed'))
           AND (m.task_assignee IS NULL OR m.task_assignee = $1)
         RETURNING m.id, old.old_status`,
        [userId, chId, num],
      );
      if (upd.rows[0]) {
        await recordTaskEvent(app, {
          messageId: String(upd.rows[0].id),
          channelId: chId,
          taskNumber: num,
          actorId: userId,
          action: "claimed",
          fromStatus: upd.rows[0].old_status,
          toStatus: "in_progress",
        });
        results.push({ number: num, status: "claimed" });
        continue;
      }
      // 未匹配：读当前行做冲突分类（尽力而为，仅用于错误码兼容）
      const cur = await app.pg.query<{ task_status: string | null; task_assignee: string | null }>(
        "SELECT task_status, task_assignee FROM messages WHERE channel_id = $1 AND task_number = $2 AND task_number IS NOT NULL",
        [chId, num],
      );
      if (!cur.rows[0]) results.push({ number: num, status: "conflict", error: "not_found" });
      else if (cur.rows[0].task_status === "done" || cur.rows[0].task_status === "closed")
        results.push({ number: num, status: "conflict", error: "task_is_done" });
      else results.push({ number: num, status: "conflict", error: "already_claimed_by_other" });
    }
    return { results };
  });

  app.post("/unclaim", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, task_number } = req.body as { channel?: string; task_number?: number };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveAccessible(req, channel, req.user.sub, reply);
    if (!ch) return;
    const existing = await app.pg.query<{ id: string; task_status: string | null }>(
      "SELECT id, task_status FROM messages WHERE channel_id = $1 AND task_number = $2 AND task_number IS NOT NULL",
      [ch.id, task_number],
    );
    await app.pg.query(
      "UPDATE messages SET task_assignee = NULL, task_status = 'todo', updated_at = now() WHERE channel_id = $1 AND task_number = $2",
      [ch.id, task_number],
    );
    if (existing.rows[0]) {
      await recordTaskEvent(app, {
        messageId: existing.rows[0].id,
        channelId: ch.id,
        taskNumber: task_number!,
        actorId: req.user.sub,
        action: "unclaimed",
        fromStatus: existing.rows[0].task_status,
        toStatus: "todo",
      });
    }
    return { ok: true };
  });

  app.post("/update-status", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channel, number, status } = req.body as { channel?: string; number?: number; status?: string };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    if (!status || !STATUSES.includes(status)) return reply.status(400).send({ error: `invalid status: ${status}` });
    const ch = await resolveAccessible(req, channel, req.user.sub, reply);
    if (!ch) return;
    const chId = ch.id;
    const before = await app.pg.query<{ id: string; task_status: string | null }>(
      "SELECT id, task_status FROM messages WHERE channel_id = $1 AND task_number = $2 AND task_number IS NOT NULL",
      [chId, number],
    );
    const result = await app.pg.query(
      "UPDATE messages SET task_status = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3 RETURNING *",
      [status, chId, number],
    );
    if (result.rows.length > 0 && before.rows[0] && before.rows[0].task_status !== status) {
      await recordTaskEvent(app, {
        messageId: before.rows[0].id,
        channelId: chId,
        taskNumber: number!,
        actorId: req.user.sub,
        action: "status_changed",
        fromStatus: before.rows[0].task_status,
        toStatus: status,
      });
      // P1.26：卡片→dispatch 回向同步——人工把 dispatch 关联卡片置 done/closed 时
      // 联动台账（done→completed、closed→cancelled；非终态 dispatch 才动）
      if (status === "done" || status === "closed") {
        await syncDispatchOnCardClose(app, String(before.rows[0].id), status);
      }
    }
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

  // 任务详情抽屉：任务本体 + 操作历史 + 批注，一次拉齐
  app.get("/detail", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { message_id } = req.query as Record<string, string>;
    if (!message_id) return reply.status(400).send({ error: "message_id required" });
    const found = await app.pg.query<{
      id: string;
      channel_id: string;
      content: string;
      task_number: number | null;
      task_status: string | null;
      task_assignee: string | null;
      created_at: string;
      sender_id: string;
      sender_type: string;
      assignee_handle: string | null;
      creator_name: string;
    }>(
      `SELECT m.id, m.channel_id, m.content, m.task_number, m.task_status, m.task_assignee, m.created_at,
              m.sender_id, m.sender_type,
              COALESCE(au.handle, aa.name) as assignee_handle,
              COALESCE(su.display_name, su.handle, sa.display_name, sa.name, 'User') as creator_name
       FROM messages m
       LEFT JOIN users au ON m.task_assignee = au.id
       LEFT JOIN agents aa ON m.task_assignee = aa.id
       LEFT JOIN users su ON m.sender_id = su.id
       LEFT JOIN agents sa ON m.sender_id = sa.id
       WHERE m.id = $1`,
      [message_id],
    );
    const msg = found.rows[0];
    if (!msg || msg.task_number == null) return reply.status(404).send({ error: "task not found" });
    const tenant = await resolveTenant(app, req);
    if (
      !(await canAccessChannel(app, msg.channel_id, req.user.sub, {
        serverId: tenant.explicit ? tenant.serverId : undefined,
        enforceServerMembership: tenant.explicit,
      }))
    ) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const events = await app.pg.query(
      "SELECT id, action, from_status, to_status, actor_name, created_at FROM task_events WHERE message_id = $1 ORDER BY created_at ASC",
      [message_id],
    );
    const comments = await app.pg.query(
      "SELECT id, content, author_id, author_name, created_at FROM task_comments WHERE message_id = $1 ORDER BY created_at ASC",
      [message_id],
    );
    const { channel_id: _channelId, ...task } = msg;
    return { task, events: events.rows, comments: comments.rows };
  });

  // 任务批注
  app.post("/comments", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { message_id, content } = req.body as { message_id?: string; content?: string };
    const text = (content || "").trim();
    if (!message_id) return reply.status(400).send({ error: "message_id required" });
    if (!text) return reply.status(400).send({ error: "content required" });
    if (text.length > 2000) return reply.status(400).send({ error: "content too long (max 2000)" });
    const found = await app.pg.query<{ id: string; channel_id: string; task_number: number | null }>(
      "SELECT id, channel_id, task_number FROM messages WHERE id = $1",
      [message_id],
    );
    const msg = found.rows[0];
    if (!msg || msg.task_number == null) return reply.status(404).send({ error: "task not found" });
    const tenant = await resolveTenant(app, req);
    if (
      !(await canAccessChannel(app, msg.channel_id, req.user.sub, {
        serverId: tenant.explicit ? tenant.serverId : undefined,
        enforceServerMembership: tenant.explicit,
      }))
    ) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    const authorName = await resolveMemberName(app, req.user.sub);
    const result = await app.pg.query(
      `INSERT INTO task_comments (message_id, author_id, author_name, content)
       VALUES ($1, $2, $3, $4) RETURNING id, content, author_id, author_name, created_at`,
      [message_id, req.user.sub, authorName, text],
    );
    return { comment: result.rows[0] };
  });
}
