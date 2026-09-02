// ============================================================================
// 本地扩展 WS 事件联合类型（AppLayout WS 分发专用）
// ============================================================================
//
// 来源：`@collabagent/shared` 的 `WsServerMessage` 是「扁平接口」，其
// `WsServerMessageType` 联合只含 9 个 type（agent:deliver / agent:start /
// agent:stop / agent:status / agent:activity_probe / reminder.* / ping），
// 且 payload 字段只有 `seq? / message? / deliveryId? / reminder? / reminders? /
// traceparent?`，与 type 无判别关系。但服务端运行时实际还广播以下事件，前端
// AppLayout（React 版 packages/web/src/components/layout/AppLayout.tsx）靠
// `(msg.type as string) === '...'` + `as any` 分发，shared 类型里「没有」：
//
//   1. notification.new       —— 见 packages/server/src/lib/notifications.ts
//                                （createNotification → sendToUser）
//   2. terminal:frame         —— 见 packages/daemon/src/daemon-core.ts（终端
//                                观察 watcher tick，server 在 ws/handler.ts
//                                里按 agentName 转发给观众）
//   3. agent:activity         —— 当前 server/daemon 代码里没有实际 emitter
//                                （仅 ws/handler.ts 的 daemon 分支 case
//                                "agent:activity" 打日志 msg.activity）；前端
//                                仍按 agentName/agentId + status + detail
//                                的形状防御性处理（ActivityProbe 应答预留）
//   4. agent:delivery-queued  —— 见 packages/daemon/src/daemon-core.ts
//                                onDeliveryQueued（{type, agentName,
//                                channelName}），server 中继给浏览器 toast
//   5. message:update         —— 见 packages/server/src/routes/messages.ts
//                                （编辑消息后 broadcast）
//   6. message:delete         —— 见 packages/server/src/routes/messages.ts
//                                （删除消息后 broadcast）
//
// 另外，`agent:status` 的 type 字面量**已在** shared 联合里，但 shared 的扁平
// WsServerMessage 没建模 agentId / agentName / status / detail 这些 payload
// 字段（status 字段反而挂在 WsClientMessage 上），故此处一并补型。
//
// 迁移回迁说明：待 shared 补全这 6 个 type 字面量与相应 payload 字段（把
// WsServerMessage 改造成 per-type 判别联合）后，本文件的本地扩展应删除，
// AppLayout 的分发改回只依赖 shared 的 WsServerMessage。
// ============================================================================

import type { WsServerMessage } from "@collabagent/shared";

// ---- notification.new ------------------------------------------------------
// 结构对齐 stores/notificationStore 的 NotificationItem（metadata: any 可兼容）
export interface NotificationNewEvent {
  type: "notification.new";
  notification: {
    id: string;
    type: string;
    actorId: string;
    actorName: string | null;
    channelId: string | null;
    messageId: string | null;
    title: string;
    body: string | null;
    metadata: Record<string, unknown> | null;
    read: boolean;
    createdAt: string;
  };
}

// ---- notification.read（P1.25：server 标记已读后的多端同步广播） ------------
// all=true 表示「全部已读」（ids 恒 null）；否则 ids 为本次标记的 id 列表。
export interface NotificationReadEvent {
  type: "notification.read";
  ids: string[] | null;
  all: boolean;
}

// ---- terminal:frame（G3 终端观察，daemon 推来的实时帧） ---------------------
export interface TerminalFrameEvent {
  type: "terminal:frame";
  agentName: string;
  screen: string;
  status: string;
  time: string;
}

// ---- agent:activity（预留 / 防御性处理，形状与 agent:status 一致） ----------
export interface AgentActivityEvent {
  type: "agent:activity";
  agentName?: string;
  agentId?: string;
  status?: string;
  detail?: string;
}

// ---- agent:delivery-queued（门控投递反馈：消息已缓冲） ----------------------
export interface AgentDeliveryQueuedEvent {
  type: "agent:delivery-queued";
  agentName: string;
  channelName?: string;
}

// ---- message:update --------------------------------------------------------
export interface MessageUpdateEvent {
  type: "message:update";
  message: {
    id: string;
    content: string;
    editedAt: string;
  };
}

// ---- message:delete --------------------------------------------------------
export interface MessageDeleteEvent {
  type: "message:delete";
  message: {
    id: string;
  };
}

// ---- agent:status（type 已在 shared，但 payload 字段 shared 未建模，补型） ----
export interface AgentStatusEvent {
  type: "agent:status";
  agentId?: string;
  agentName?: string;
  status?: string;
  detail?: string;
}

/** shared 联合之外、由本文件补齐的 7 个本地运行时事件 */
export type LocalWsEvent =
  | NotificationNewEvent
  | NotificationReadEvent
  | TerminalFrameEvent
  | AgentActivityEvent
  | AgentDeliveryQueuedEvent
  | MessageUpdateEvent
  | MessageDeleteEvent;

/** AppLayout WS 分发用的事件联合：shared 的 WsServerMessage + 本地扩展 + agent:status 补型 */
export type WsServerEvent = WsServerMessage | LocalWsEvent | AgentStatusEvent;
