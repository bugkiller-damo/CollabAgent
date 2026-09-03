import type { FastifyInstance } from "fastify";
import { agentCanAccessChannel, requireOwnAgent, resolveChannelByName } from "../lib/agent-helpers.js";
import { syncDispatchOnCardClose } from "../lib/dispatch-sync.js";
import { recordTaskEvent } from "../lib/task-events.js";
import { acquireTaskNumberLock } from "../lib/task-numbering.js";

const STATUSES = ["todo", "in_progress", "in_review", "done", "closed"];

export async function agentTaskRoutes(app: FastifyInstance) {
  app.get("/:agentId/tasks", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, status } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    let q =
      "SELECT id, content, task_number, task_status, task_assignee, created_at FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL";
    const p: any[] = [ch.id];
    if (status && status !== "all") {
      p.push(status);
      q += ` AND task_status = $${p.length}`;
    }
    return { tasks: (await app.pg.query(q + " ORDER BY task_number ASC", p)).rows };
  });

  app.post("/:agentId/tasks", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, tasks } = req.body as { channel?: string; tasks?: { title: string }[] };
    if (!channel || !tasks?.length) return reply.status(400).send({ error: "channel and tasks required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    // P0.5：取号持频道级 advisory lock 串行化，锁内读 MAX + 连续 INSERT，防并发重号
    const created: any[] = await app.pg.transaction(async (tx) => {
      await acquireTaskNumberLock(tx, ch.id);
      const maxNum = await tx.query<{ n: number }>(
        "SELECT COALESCE(MAX(task_number), 0) as n FROM messages WHERE channel_id = $1 AND task_number IS NOT NULL",
        [ch.id],
      );
      let next = Number(maxNum.rows[0]!.n);
      const rows: any[] = [];
      for (const t of tasks) {
        next++;
        const r = await tx.query(
          "INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content, task_number, task_status) VALUES ($1, $2, $3, 'agent', $4, $5, 'todo') RETURNING id, task_number, content",
          [ch.id, ch.server_id, agentId, t.title, next],
        );
        rows.push(r.rows[0]);
      }
      return rows;
    });
    return { tasks: created };
  });

  app.post("/:agentId/tasks/claim", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, task_numbers, message_ids } = req.body as {
      channel?: string;
      task_numbers?: number[];
      message_ids?: string[];
    };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const nums: number[] = [...(task_numbers || [])];
    for (const mid of message_ids || []) {
      const r = await app.pg.query("SELECT task_number FROM messages WHERE id = $1 AND channel_id = $2", [mid, ch.id]);
      if (r.rows[0]?.task_number != null) nums.push(Number(r.rows[0].task_number));
    }
    const results: any[] = [];
    for (const num of nums) {
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
        [agentId, ch.id, num],
      );
      if (upd.rows[0]) {
        await recordTaskEvent(app, {
          messageId: upd.rows[0].id,
          channelId: ch.id,
          taskNumber: num,
          actorId: agentId,
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
        [ch.id, num],
      );
      if (!cur.rows[0]) results.push({ number: num, status: "conflict", error: "not_found" });
      else if (cur.rows[0].task_status === "done" || cur.rows[0].task_status === "closed")
        results.push({ number: num, status: "conflict", error: "task_is_done" });
      else results.push({ number: num, status: "conflict", error: "already_claimed_by_other" });
    }
    return { results };
  });

  app.post("/:agentId/tasks/unclaim", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, task_number } = req.body as { channel?: string; task_number?: number };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const before = await app.pg.query<{ id: string; task_status: string | null }>(
      "SELECT id, task_status FROM messages WHERE channel_id = $1 AND task_number = $2 AND task_number IS NOT NULL",
      [ch.id, task_number],
    );
    await app.pg.query(
      "UPDATE messages SET task_assignee = NULL, task_status = 'todo', updated_at = now() WHERE channel_id = $1 AND task_number = $2",
      [ch.id, task_number],
    );
    if (before.rows[0]) {
      await recordTaskEvent(app, {
        messageId: before.rows[0].id,
        channelId: ch.id,
        taskNumber: task_number!,
        actorId: agentId,
        action: "unclaimed",
        fromStatus: before.rows[0].task_status,
        toStatus: "todo",
      });
    }
    return { ok: true };
  });

  app.post("/:agentId/tasks/update-status", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, number, status } = req.body as { channel?: string; number?: number; status?: string };
    if (!channel) return reply.status(400).send({ error: "channel required" });
    if (!status || !STATUSES.includes(status)) return reply.status(400).send({ error: `invalid status: ${status}` });
    const ch = await resolveChannelByName(app, channel);
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await agentCanAccessChannel(app, ch.id, agentId))) return reply.status(403).send({ error: "no access" });
    const before = await app.pg.query<{ id: string; task_status: string | null }>(
      "SELECT id, task_status FROM messages WHERE channel_id = $1 AND task_number = $2 AND task_number IS NOT NULL",
      [ch.id, number],
    );
    const r = await app.pg.query<{ id: string; task_number: number; task_status: string }>(
      "UPDATE messages SET task_status = $1, updated_at = now() WHERE channel_id = $2 AND task_number = $3 RETURNING id, task_number, task_status",
      [status, ch.id, number],
    );
    if (r.rows[0] && before.rows[0] && before.rows[0].task_status !== status) {
      await recordTaskEvent(app, {
        messageId: r.rows[0].id,
        channelId: ch.id,
        taskNumber: number!,
        actorId: agentId,
        action: "status_changed",
        fromStatus: before.rows[0].task_status,
        toStatus: status,
      });
      // P1.26：卡片→dispatch 回向同步（与 tasks.ts 人类侧同款）——agent 把
      // dispatch 关联卡片置 done/closed 时联动台账终态
      if (status === "done" || status === "closed") {
        await syncDispatchOnCardClose(app, String(r.rows[0].id), status);
      }
    }
    return { ok: true, task: r.rows[0] };
  });
}
