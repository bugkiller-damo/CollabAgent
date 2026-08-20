import type { WsToBrowserMessage } from "@collabagent/shared";
import type { FastifyInstance } from "fastify";
import { sendToUser } from "../ws/handler.js";

export type NotificationType = "@mention" | "task_assigned" | "dm" | "reminder" | "patrol_paused";

export interface CreateNotificationOpts {
  userId: string; // 通知接收人
  type: NotificationType;
  actorId: string; // 触发者（用户/agent ID）
  actorName?: string; // 触发者显示名
  channelId?: string; // 关联频道
  messageId?: string; // 关联消息
  title: string; // 通知标题
  body?: string; // 通知预览内容
  metadata?: Record<string, unknown>;
}

/**
 * 创建通知并实时 WS 推送
 */
export async function createNotification(app: FastifyInstance, opts: CreateNotificationOpts) {
  const result = await app.pg.query(
    `INSERT INTO notifications (user_id, type, actor_id, actor_name, channel_id, message_id, title, body, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      opts.userId,
      opts.type,
      opts.actorId,
      opts.actorName || null,
      opts.channelId || null,
      opts.messageId || null,
      opts.title,
      opts.body || null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ],
  );
  const row = result.rows[0] as any;

  // WS 实时推送
  const event: WsToBrowserMessage = {
    type: "notification.new",
    notification: {
      id: row.id,
      type: opts.type,
      actorId: opts.actorId,
      actorName: opts.actorName || null,
      channelId: opts.channelId || null,
      messageId: opts.messageId || null,
      title: opts.title,
      body: opts.body || null,
      metadata: opts.metadata || null,
      read: false,
      createdAt: row.created_at,
    },
  };
  sendToUser(opts.userId, event);
}
