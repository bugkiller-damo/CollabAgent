import type { FastifyInstance } from "fastify";
import { daemonClients, broadcastToDaemons } from "../ws/handler.js";
import { nextFireFromRepeat } from "./reminders.js";

// 周期扫描到期提醒：唤醒对应 daemon（agent），周期性的算下一次、一次性的标记完成。
// 没有 daemon 连接时跳过本轮（提醒保持到期状态，等 daemon 连上再触发）。
//
// 多实例安全：用「原子认领」——单条 UPDATE 把到期提醒直接翻成 fired，认领集合由
// `FOR UPDATE SKIP LOCKED` 子查询挑选；并发的多个调度实例不会认领到同一行，
// 因此不会重复 fire。一次性提醒就停在 fired；周期性提醒认领后立即重排回 scheduled。
export function startReminderScheduler(app: FastifyInstance, intervalMs = 20000): () => void {
  const tick = async () => {
    try {
      if (daemonClients.size === 0) return;
      // 原子认领：把到期的 scheduled 提醒一次性翻成 fired 并取回（其它实例 SKIP LOCKED 跳过）
      const claimed = await app.pg.query(
        `UPDATE reminders SET status = 'fired', last_fired_at = now(), fire_count = fire_count + 1, updated_at = now()
           WHERE id IN (
             SELECT id FROM reminders
              WHERE status = 'scheduled' AND fire_at <= now()
              ORDER BY fire_at ASC
              LIMIT 20
              FOR UPDATE SKIP LOCKED
           )
         RETURNING *`
      );
      if (claimed.rows.length > 0) {
        const { inc } = await import("./metrics.js");
        inc("remindersFired", claimed.rows.length);
      }
      for (const r of claimed.rows as any[]) {
        broadcastToDaemons({
          type: "reminder.fire",
          agentId: r.owner_id,
          reminder: { id: r.id, title: r.title, channel: r.channel_ref || null },
        });
        // 周期性提醒：认领后立即排下一次（翻回 scheduled）。
        const next = r.repeat_rule ? nextFireFromRepeat(r.repeat_rule, new Date()) : null;
        if (next) {
          await app.pg.query(
            "UPDATE reminders SET status = 'scheduled', fire_at = $1, updated_at = now() WHERE id = $2",
            [next.toISOString(), r.id]
          );
        }
        // 持久化事件日志（best-effort，不阻断 fire）
        await app.pg
          .query(
            "INSERT INTO reminder_events (reminder_id, event_type, detail) VALUES ($1, 'fired', $2::jsonb)",
            [r.id, JSON.stringify({ title: r.title, repeat: r.repeat_rule || null, next: next ? next.toISOString() : null })]
          )
          .catch(() => {});
        console.log(`[Reminder] fired "${r.title}" for agent ${String(r.owner_id).slice(0, 8)}`);
      }
    } catch (err) {
      console.error("[Reminder] scheduler error:", (err as Error).message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
