import type { FastifyInstance } from "fastify";

export type TaskEventAction = "created" | "claimed" | "unclaimed" | "status_changed";

export interface RecordTaskEventInput {
  messageId: string;
  channelId: string;
  taskNumber: number;
  /** user 或 agent 的 id；null/undefined 记为 system */
  actorId?: string | null;
  action: TaskEventAction;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: string | null;
}

/** 解析成员显示名：先 users（display_name/handle），再 agents（display_name/name），兜底 unknown。 */
export async function resolveMemberName(app: FastifyInstance, id: string): Promise<string> {
  const u = await app.pg.query<{ name: string | null }>(
    "SELECT COALESCE(display_name, handle) AS name FROM users WHERE id = $1",
    [id],
  );
  if (u.rows[0]?.name) return u.rows[0].name;
  const a = await app.pg.query<{ name: string | null }>(
    "SELECT COALESCE(display_name, name) AS name FROM agents WHERE id = $1",
    [id],
  );
  if (a.rows[0]?.name) return a.rows[0].name;
  return "unknown";
}

/**
 * 记录一次任务操作历史。绝不抛出：事件记录失败只 warn，不能拖垮主流程
 * （认领/改状态等操作本身已经成功）。
 */
export async function recordTaskEvent(app: FastifyInstance, input: RecordTaskEventInput): Promise<void> {
  try {
    const actorName = input.actorId ? await resolveMemberName(app, input.actorId) : "system";
    await app.pg.query(
      `INSERT INTO task_events (message_id, channel_id, task_number, actor_id, actor_name, action, from_status, to_status, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.messageId,
        input.channelId,
        input.taskNumber,
        input.actorId ?? null,
        actorName,
        input.action,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        input.detail ?? null,
      ],
    );
  } catch (err) {
    app.log.warn({ err }, "recordTaskEvent failed");
  }
}
