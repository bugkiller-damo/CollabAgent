// ============================================================
// CollabAgent — 共享类型定义
// 基于 Slock 数据模型逆向分析
// ============================================================

// ---- 基础类型 ----

export type UUID = string;
export type ISO8601 = string;
export type Email = string;

// ---- 消息 ----

export type MessageType = "human" | "agent" | "system";

export type TargetKind = "channel" | "dm" | "thread";

export interface MessageTarget {
  kind: TargetKind;
  channel?: string;          // "#general"
  peer?: string;             // "@alice" (DM)
  threadId?: string;         // 线程短 ID (8 字符)
}

export interface Message {
  id: UUID;
  seq: number;               // 全局递增序列号
  channelId: UUID;
  senderId: UUID;
  senderName: string;
  senderType: MessageType;
  content: string;           // Markdown
  time: ISO8601;
  threadId?: UUID;           // 所属线程的父消息 ID (NULL = top-level)
  replyTarget?: string;
  // 任务扩展
  taskNumber?: number;
  taskStatus?: TaskStatus;
  taskAssignee?: UUID;
  // 附件
  attachments?: AttachmentRef[];
  // 反应
  reactions?: Reaction[];
  // Trace
  traceparent?: string;
}

export interface Reaction {
  emoji: string;
  userId: UUID;
  createdAt: ISO8601;
}

export interface AttachmentRef {
  id: UUID;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

// ---- 频道 ----

export type ChannelVisibility = "public" | "private";

export interface Channel {
  id: UUID;
  serverId: UUID;
  name: string;              // "#general"
  description?: string;
  visibility: ChannelVisibility;
  joined?: boolean;          // 当前用户/agent 是否已加入
  archived: boolean;
  memberCount: number;
  createdAt: ISO8601;
}

export type MemberRole = "owner" | "admin" | "member";
export type MemberType = "human" | "agent";

export interface ChannelMember {
  channelId: UUID;
  memberId: UUID;
  memberType: MemberType;
  role: MemberRole;
  joinedAt: ISO8601;
}

// ---- 用户 ----

export interface User {
  id: UUID;
  handle: string;            // @mention 唯一标识
  displayName: string;
  description?: string;
  avatarUrl?: string;
  createdAt: ISO8601;
}

// ---- Agent ----

export type AgentStatus = "active" | "inactive" | "sleeping";

export interface Agent {
  id: UUID;
  userId: UUID;
  serverId: UUID;
  name: string;              // stable @handle
  displayName: string;
  description?: string;
  avatarUrl?: string;
  status: AgentStatus;
  runtime: string;           // "claude" | "codex" | "kimi" | ...
  model: string;
  capabilities: string[];    // ["send", "read", "tasks", ...]
  createdAt: ISO8601;
}

// ---- 任务 ----

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";

export interface Task {
  number: number;            // 频道内自增
  messageId: UUID;
  channelId: UUID;
  title: string;
  status: TaskStatus;
  assignee?: UUID;           // agent ID
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

// ---- 提醒 ----

export type ReminderStatus = "scheduled" | "fired" | "canceled";

export type RepeatRule = string;  // "every:15m" | "daily@09:00" | "weekly:mon,fri@09:00"

export interface Reminder {
  id: UUID;
  ownerId: UUID;
  title: string;
  fireAt: ISO8601;
  repeatRule?: RepeatRule;
  channelRef?: string;
  anchorMsgId?: UUID;
  status: ReminderStatus;
  createdAt: ISO8601;
}

export type ReminderEventType = "created" | "fired" | "snoozed" | "updated" | "canceled" | "dismissed";

export interface ReminderEvent {
  id: UUID;
  reminderId: UUID;
  eventType: ReminderEventType;
  detail?: Record<string, unknown>;
  createdAt: ISO8601;
}

// ---- 附件 ----

export interface Attachment {
  id: UUID;
  uploaderId: UUID;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  storageUrl: string;
  createdAt: ISO8601;
}

// ---- 认证 ----

export type ClientMode = "managed-runner" | "self-hosted-runner" | "legacy-machine";

export interface AuthContext {
  agentId: UUID;
  serverUrl: string;
  serverId: UUID | null;
  token: string;
  clientMode: ClientMode;
  capabilities: string[];
}

export interface MachineToken {
  id: UUID;
  userId: UUID;
  serverId: UUID;
  tokenHash: string;
  tokenPrefix: string;       // "sk_machine_"
  scope: Record<string, unknown>;
  expiresAt?: ISO8601;
  revokedAt?: ISO8601;
}

// ---- 操作卡片 ----

export type ActionType = "channel:create" | "agent:create";

export interface ActionCard {
  id: UUID;
  channelId: UUID;
  createdBy: UUID;           // agent ID
  targetUser: UUID;
  actionType: ActionType;
  actionData: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  createdAt: ISO8601;
}

// ---- 集成 ----

export interface Integration {
  id: UUID;
  serviceId: string;
  name: string;
  provider: string;
  config: Record<string, unknown>;
}

export interface AgentLogin {
  id: UUID;
  agentId: UUID;
  integrationId: UUID;
  status: "active" | "expired" | "revoked";
  expiresAt?: ISO8601;
}

// ---- WebSocket 消息类型 ----

export type WsServerMessageType =
  | "agent:deliver"
  | "agent:start"
  | "agent:stop"
  | "agent:status"
  | "agent:activity_probe"
  | "reminder.upsert"
  | "reminder.cancel"
  | "reminder.snapshot"
  | "ping";

export type WsClientMessageType =
  | "ready"
  | "agent:deliver:ack"
  | "agent:activity"
  | "agent:status"
  | "pong";

export interface WsServerMessage {
  type: WsServerMessageType;
  seq?: number;
  message?: Message;
  deliveryId?: UUID;
  reminder?: Reminder;
  reminders?: Reminder[];
  traceparent?: string;
}

export interface WsClientMessage {
  type: WsClientMessageType;
  seq?: number;
  status?: string;
  traceparent?: string;
}

// ---- API 响应 ----

export interface ApiError {
  ok: false;
  code: string;
  message: string;
}

export interface ApiOk<T = unknown> {
  ok: true;
  data: T;
}

export type ApiResponse<T = unknown> = ApiOk<T> | ApiError;

// ---- 分页 ----

export interface PaginationOpts {
  before?: number;           // seq
  after?: number;
  around?: UUID;             // message UUID
  limit?: number;            // 默认 50
}
