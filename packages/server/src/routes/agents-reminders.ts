import type { FastifyInstance } from "fastify";
import { requireOwnAgent } from "../lib/agent-helpers.js";
import {
  initialFireAt,
  nextFireFromRepeat,
  PATROL_MAX_PER_AGENT,
  parseDurationToMs,
  reminderToDto,
  validatePatrolRepeat,
} from "../lib/reminders.js";

// Agent 提醒/巡检路由。kind='reminder'（默认）行为与 T2 之前完全一致；
// kind='patrol'（T2 巡检任务）多了：instructions 任务指令、频率下限/数量上限校验、
// pause/resume 端点（resume 重新排程并清零连续沉默计数）。
export async function agentReminderRoutes(app: FastifyInstance) {
  app.post("/:agentId/reminders", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const body = (req.body as Record<string, unknown>) || {};
    if (!body.title) return reply.status(400).send({ error: "title required" });
    const kind = body.kind === "patrol" ? "patrol" : "reminder";
    // T2 patrol 护栏：repeat 必须可解析且 ≥ 5min（one-shot patrol 不带 repeat 合法）；
    // 活跃 patrol 数量上限防失控（D4 参数侧保险）
    if (kind === "patrol") {
      if (body.repeat) {
        const err = validatePatrolRepeat(String(body.repeat));
        if (err) return reply.status(400).send({ error: err });
      }
      const cnt = await app.pg.query<{ count: string }>(
        "SELECT count(*) AS count FROM reminders WHERE owner_id = $1 AND kind = 'patrol' AND status = 'scheduled' AND NOT paused",
        [agentId],
      );
      if (Number(cnt.rows[0]?.count ?? 0) >= PATROL_MAX_PER_AGENT) {
        return reply.status(400).send({ error: `too many active patrols (max ${PATROL_MAX_PER_AGENT})` });
      }
    }
    const fireAt = initialFireAt(body);
    if (!fireAt) return reply.status(400).send({ error: "need fireAt, delaySeconds, or repeat" });
    const r = await app.pg.query(
      `INSERT INTO reminders (owner_id, title, fire_at, repeat_rule, channel_ref, status, kind, instructions, max_consecutive_silent)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7, $8) RETURNING *`,
      [
        agentId,
        body.title,
        fireAt.toISOString(),
        body.repeat || null,
        body.channel || null,
        kind,
        body.instructions ? String(body.instructions) : null,
        Math.max(1, Math.min(100, Number(body.maxConsecutiveSilent) || 5)),
      ],
    );
    return { reminder: reminderToDto(r.rows[0]) };
  });

  app.get("/:agentId/reminders", { preHandler: [app.authenticate, requireOwnAgent] }, async (req) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { status, kind } = req.query as Record<string, string>;
    const all = status === "all";
    const params: unknown[] = [agentId];
    let sql = "SELECT * FROM reminders WHERE owner_id = $1 " + (all ? "" : "AND status = 'scheduled' ");
    if (kind === "patrol" || kind === "reminder") {
      params.push(kind);
      sql += `AND kind = $${params.length} `;
    }
    sql += "ORDER BY fire_at ASC";
    const r = await app.pg.query(sql, params);
    return { reminders: r.rows.map(reminderToDto) };
  });

  app.delete(
    "/:agentId/reminders/:reminderId",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        reminderId = (req.params as Record<string, string>).reminderId;
      const r = await app.pg.query(
        "UPDATE reminders SET status = 'canceled', updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING id",
        [reminderId, agentId],
      );
      if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
      return { ok: true };
    },
  );

  app.post(
    "/:agentId/reminders/:reminderId/snooze",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        reminderId = (req.params as Record<string, string>).reminderId;
      const ms = parseDurationToMs(String((req.body as { duration?: string })?.duration || ""));
      if (!ms) return reply.status(400).send({ error: "invalid duration (e.g. 30m, 2h)" });
      const cur = await app.pg.query<{ fire_at: string }>(
        "SELECT fire_at FROM reminders WHERE id = $1 AND owner_id = $2",
        [reminderId, agentId],
      );
      if (cur.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
      const next = new Date(Math.max(Date.now(), new Date(cur.rows[0]!.fire_at).getTime()) + ms);
      const r = await app.pg.query(
        "UPDATE reminders SET fire_at = $1, status = 'scheduled', updated_at = now() WHERE id = $2 AND owner_id = $3 RETURNING *",
        [next.toISOString(), reminderId, agentId],
      );
      return { reminder: reminderToDto(r.rows[0]) };
    },
  );

  // T2 暂停：paused=true（scheduler 认领条件含 NOT paused，立即退出调度面）。
  // 停在原 status 不动；resume 时统一重新排程。
  app.post(
    "/:agentId/reminders/:reminderId/pause",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        reminderId = (req.params as Record<string, string>).reminderId;
      const r = await app.pg.query(
        "UPDATE reminders SET paused = true, updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING *",
        [reminderId, agentId],
      );
      if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
      await app.pg
        .query("INSERT INTO reminder_events (reminder_id, event_type, detail) VALUES ($1, 'paused', $2::jsonb)", [
          reminderId,
          JSON.stringify({ title: r.rows[0].title }),
        ])
        .catch(() => {});
      return { reminder: reminderToDto(r.rows[0]) };
    },
  );

  // T2 恢复：清 paused + 清零连续沉默计数 + 重新排程（按 repeat_rule 算下一个周期；
  // 无 repeat 的 one-shot 立即到期）。被自动暂停的 patrol 由此回到调度面。
  app.post(
    "/:agentId/reminders/:reminderId/resume",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        reminderId = (req.params as Record<string, string>).reminderId;
      const cur = await app.pg.query<{ repeat_rule: string | null; status: string; title: string }>(
        "SELECT repeat_rule, status, title FROM reminders WHERE id = $1 AND owner_id = $2",
        [reminderId, agentId],
      );
      if (cur.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
      const row = cur.rows[0]!;
      if (row.status === "canceled") return reply.status(400).send({ error: "canceled reminder cannot resume" });
      const fireAt = (row.repeat_rule ? nextFireFromRepeat(row.repeat_rule, new Date()) : null) ?? new Date();
      const r = await app.pg.query(
        `UPDATE reminders SET paused = false, consecutive_silent = 0,
           status = 'scheduled', fire_at = $1, updated_at = now()
         WHERE id = $2 AND owner_id = $3 RETURNING *`,
        [fireAt.toISOString(), reminderId, agentId],
      );
      await app.pg
        .query("INSERT INTO reminder_events (reminder_id, event_type, detail) VALUES ($1, 'resumed', $2::jsonb)", [
          reminderId,
          JSON.stringify({ title: row.title, next: fireAt.toISOString() }),
        ])
        .catch(() => {});
      return { reminder: reminderToDto(r.rows[0]) };
    },
  );

  app.patch(
    "/:agentId/reminders/:reminderId",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        reminderId = (req.params as Record<string, string>).reminderId;
      const body = (req.body as Record<string, unknown>) || {};
      // patrol 改 repeat 时同样过护栏校验（先查 kind）
      if (body.repeat !== undefined || body.instructions !== undefined) {
        const cur = await app.pg.query("SELECT kind FROM reminders WHERE id = $1 AND owner_id = $2", [
          reminderId,
          agentId,
        ]);
        if (cur.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
        if (cur.rows[0].kind === "patrol" && body.repeat) {
          const err = validatePatrolRepeat(String(body.repeat));
          if (err) return reply.status(400).send({ error: err });
        }
      }
      const sets: string[] = [];
      const params: any[] = [];
      let p = 1;
      if (body.title !== undefined) {
        sets.push(`title = $${p++}`);
        params.push(body.title);
      }
      if (body.instructions !== undefined) {
        sets.push(`instructions = $${p++}`);
        params.push(body.instructions ? String(body.instructions) : null);
      }
      if (body.maxConsecutiveSilent !== undefined) {
        sets.push(`max_consecutive_silent = $${p++}`);
        params.push(Math.max(1, Math.min(100, Number(body.maxConsecutiveSilent) || 5)));
      }
      if (body.repeat !== undefined) {
        sets.push(`repeat_rule = $${p++}`);
        params.push(body.repeat || null);
      }
      if (body.fireAt || body.delaySeconds != null) {
        const f = initialFireAt(body);
        if (f) {
          sets.push(`fire_at = $${p++}`);
          params.push(f.toISOString());
        }
      }
      if (sets.length === 0) return reply.status(400).send({ error: "no fields" });
      sets.push("updated_at = now()");
      params.push(reminderId, agentId);
      const r = await app.pg.query(
        `UPDATE reminders SET ${sets.join(", ")} WHERE id = $${p++} AND owner_id = $${p} RETURNING *`,
        params,
      );
      if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
      return { reminder: reminderToDto(r.rows[0]) };
    },
  );

  // 事件日志：直接读 reminder_events 表（T2 起 fired 事件带 outcome，另有
  // paused/resumed/auto_paused），与用户侧 /api/reminders/:id/log 对齐。
  app.get(
    "/:agentId/reminders/:reminderId/log",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId,
        reminderId = (req.params as Record<string, string>).reminderId;
      const r = await app.pg.query("SELECT * FROM reminders WHERE id = $1 AND owner_id = $2", [reminderId, agentId]);
      if (r.rows.length === 0) return reply.status(404).send({ error: "reminder not found" });
      const events = await app.pg.query(
        "SELECT event_type, detail, created_at FROM reminder_events WHERE reminder_id = $1 ORDER BY created_at ASC",
        [reminderId],
      );
      return { reminder: reminderToDto(r.rows[0]), events: events.rows };
    },
  );
}
