import type { FastifyInstance } from "fastify";
import { daemonClients, sendToDaemon } from "../ws/handler.js";
import { createNotification } from "./notifications.js";
import { nextFireFromRepeat } from "./reminders.js";

// 周期扫描到期提醒：唤醒对应 daemon（agent），周期性的算下一次、一次性的标记完成。
// 没有 daemon 连接时跳过本轮（提醒保持到期状态，等 daemon 连上再触发）。
//
// 多实例安全：单事务内 `FOR UPDATE SKIP LOCKED` 选出到期行并持锁认领，
// 并发的多个调度实例不会认领到同一行，因此不会重复 fire。
//
// T2 patrol 护栏（设计:docs/2026-08-19/02-t2-agent-patrol-design.md）：
// - paused 行不认领（D3 独立布尔列，resume 时才回到调度面）；
// - 沉默判定（D2）：认领时回看上一轮——自上次 fire 至今该 agent 在目标频道
//   有无发言，无则 consecutive_silent+1，有则清零；
// - 空转自动暂停：consecutive_silent 达到 max_consecutive_silent → paused=true，
//   写 reminder_events 'auto_paused' 并通知 owner，不再重排（resume 时重新排程）；
// - 结果回写：'fired' 事件 detail 带 outcome（posted/silent），供审计与 T3 活动馈送。

interface ClaimedReminder {
  id: string;
  owner_id: string;
  title: string;
  channel_ref: string | null;
  repeat_rule: string | null;
  kind: string;
  instructions: string | null;
  last_fired_at: string | null; // 认领前的上一次 fire 时间（首次 fire 为 null）
  consecutive_silent: number;
  max_consecutive_silent: number;
  // 事务内判定、提交后使用的扩展字段
  outcome: "posted" | "silent" | null;
  newConsecutiveSilent: number;
  autoPaused: boolean;
}

// 上一轮 patrol 是否有产出：agent 自上次 fire 以来在目标频道发过消息。
// channel_ref 为空时退化为「该 agent 在任意频道发言」。
// 注意：不按 agents.server_id 约束频道——个人 agent 的 server_id 是「归属 server」，
// 不代表它的实际活动面（实测：agent server_id=e49e… 却长期在 a319… server 的
// #general 发言，加 server 约束会把真实发言判成沉默 → 误自动暂停，2026-08-19 E2E 实锤）。
// channel 名跨 server 撞名的误计在多租户下理论存在，单租户部署无影响（D2 v1 代理精度）。
async function hasAgentPostedSince(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  r: ClaimedReminder,
): Promise<boolean> {
  const channelName = (r.channel_ref || "").replace(/^#/, "").split(":")[0];
  if (channelName) {
    const q = await tx.query(
      `SELECT 1 FROM messages m
        JOIN channels c ON c.id = m.channel_id
       WHERE m.sender_id = $1 AND m.sender_type = 'agent'
         AND c.name = $2
         AND m.created_at > $3
       LIMIT 1`,
      [r.owner_id, channelName, r.last_fired_at],
    );
    return q.rows.length > 0;
  }
  const q = await tx.query(
    `SELECT 1 FROM messages WHERE sender_id = $1 AND sender_type = 'agent' AND created_at > $2 LIMIT 1`,
    [r.owner_id, r.last_fired_at],
  );
  return q.rows.length > 0;
}

export function startReminderScheduler(app: FastifyInstance, intervalMs = 20000): () => void {
  const tick = async () => {
    try {
      if (daemonClients.size === 0) {
        app.log?.info?.("[Reminder] skip: no daemon");
        return;
      }
      // 原子认领：单事务 SKIP LOCKED 选出到期行（paused 不认领），持锁逐行更新。
      // 沉默判定必须在 UPDATE 之前做——认领会覆盖 last_fired_at，判定依赖旧值。
      const claimed = await app.pg.transaction(async (tx) => {
        const due = await tx.query(
          `SELECT id, owner_id, title, channel_ref, repeat_rule, kind, instructions,
                  last_fired_at, consecutive_silent, max_consecutive_silent
             FROM reminders
            WHERE status = 'scheduled' AND fire_at <= now() AND NOT paused
            ORDER BY fire_at ASC
            LIMIT 20
            FOR UPDATE SKIP LOCKED`,
        );
        const rows = due.rows as unknown as ClaimedReminder[];
        for (const r of rows) {
          r.outcome = null;
          r.newConsecutiveSilent = 0;
          r.autoPaused = false;
          if (r.kind === "patrol" && r.last_fired_at) {
            const posted = await hasAgentPostedSince(tx, r);
            r.outcome = posted ? "posted" : "silent";
            r.newConsecutiveSilent = posted ? 0 : r.consecutive_silent + 1;
            r.autoPaused = r.newConsecutiveSilent >= r.max_consecutive_silent;
          }
          await tx.query(
            `UPDATE reminders
                SET status = 'fired', last_fired_at = now(), fire_count = fire_count + 1,
                    consecutive_silent = $2, paused = paused OR $3, updated_at = now()
              WHERE id = $1`,
            [r.id, r.newConsecutiveSilent, r.autoPaused],
          );
        }
        return rows;
      });
      if (claimed.length > 0) {
        const { inc } = await import("./metrics.js");
        inc("remindersFired", claimed.length);
        for (const r of claimed) {
          if (r.outcome === "posted") inc("patrolPosted");
          else if (r.outcome === "silent") inc("patrolSilent");
          if (r.autoPaused) inc("patrolAutoPaused");
        }
      }
      for (const r of claimed) {
        // 解析出这个 agent 的所有者，只通知对应那台 daemon——广播会让别的 daemon
        // 误把它当成自己托管的 agent 尝试拉起，spawn 阶段 403 "not your agent"。
        const owner = await app.pg.query<{ user_id: string }>("SELECT user_id FROM agents WHERE id = $1", [r.owner_id]);
        const ownerUserId = owner.rows[0]?.user_id;
        if (ownerUserId) {
          sendToDaemon(String(ownerUserId), {
            type: "reminder.fire",
            agentId: r.owner_id,
            reminder: {
              id: r.id,
              title: r.title,
              channel: r.channel_ref || null,
              kind: r.kind || "reminder",
              instructions: r.instructions || null,
            },
          });
        }
        // 周期性提醒：认领后立即排下一次（翻回 scheduled）。
        // 自动暂停的 patrol 不重排——停在 fired+paused，等 resume 时重新排程。
        const next = r.repeat_rule && !r.autoPaused ? nextFireFromRepeat(r.repeat_rule, new Date()) : null;
        if (next) {
          await app.pg.query(
            "UPDATE reminders SET status = 'scheduled', fire_at = $1, updated_at = now() WHERE id = $2",
            [next.toISOString(), r.id],
          );
        }
        // 持久化事件日志（best-effort，不阻断 fire）
        await app.pg
          .query("INSERT INTO reminder_events (reminder_id, event_type, detail) VALUES ($1, 'fired', $2::jsonb)", [
            r.id,
            JSON.stringify({
              title: r.title,
              repeat: r.repeat_rule || null,
              next: next ? next.toISOString() : null,
              ...(r.outcome ? { outcome: r.outcome, consecutiveSilent: r.newConsecutiveSilent } : {}),
            }),
          ])
          .catch(() => {});
        // 空转自动暂停：事件 + 通知 owner（人在哪里都能看见，不等进频道才发现）
        if (r.autoPaused) {
          await app.pg
            .query(
              "INSERT INTO reminder_events (reminder_id, event_type, detail) VALUES ($1, 'auto_paused', $2::jsonb)",
              [
                r.id,
                JSON.stringify({
                  title: r.title,
                  consecutiveSilent: r.newConsecutiveSilent,
                  maxConsecutiveSilent: r.max_consecutive_silent,
                }),
              ],
            )
            .catch(() => {});
          if (ownerUserId) {
            await createNotification(app, {
              userId: String(ownerUserId),
              type: "patrol_paused",
              actorId: String(r.owner_id),
              title: `巡检任务「${r.title}」已自动暂停`,
              body: `连续 ${r.newConsecutiveSilent} 次触发均无产出，达到上限（${r.max_consecutive_silent}）。确认后可在提醒列表恢复。`,
              metadata: { reminderId: r.id, kind: "patrol" },
            }).catch(() => {});
          }
        }
        app.log?.info?.(
          `[Reminder] fired "${r.title}" for agent ${String(r.owner_id).slice(0, 8)}` +
            (r.outcome ? ` (patrol outcome=${r.outcome}, silent=${r.newConsecutiveSilent})` : "") +
            (r.autoPaused ? " [AUTO-PAUSED]" : ""),
        );
      }
    } catch (err) {
      app.log.error({ err: (err as Error).message }, "[Reminder] scheduler error");
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
