// ============================================================
// CollabAgent — 共享类型定义
// 基于 Slock 数据模型逆向分析
// ============================================================

import type { AgentDuty, AgentPresence } from "./presence.js";

// ---- 基础类型 ----

export type UUID = string;
export type ISO8601 = string;
export type Email = string;

// ---- 消息 ----

export type MessageType = "human" | "agent" | "system";

export type TargetKind = "channel" | "dm" | "thread";

export interface MessageTarget {
  kind: TargetKind;
  channel?: string; // "#general"
  peer?: string; // "@alice" (DM)
  threadId?: string; // 线程短 ID (8 字符)
}

export interface Message {
  id: UUID;
  seq: number; // 全局递增序列号
  channelId: UUID;
  senderId: UUID;
  senderName: string;
  /** users.handle / agents.name；点开档案用。历史消息可能缺省 */
  senderHandle?: string;
  senderType: MessageType;
  content: string; // Markdown
  time: ISO8601;
  threadId?: UUID; // 所属线程的父消息 ID (NULL = top-level)
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
  name: string; // "#general"
  description?: string;
  visibility: ChannelVisibility;
  joined?: boolean; // 当前用户/agent 是否已加入
  archived: boolean;
  memberCount: number;
  createdAt: ISO8601;
  /** T8：频道经理自动分诊开关（DB 列 manager_triage_enabled；默认关） */
  managerTriageEnabled?: boolean;
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

// ---- 成员档案（GET /api/people/:handle）----

export interface PersonChannelContext {
  id: string;
  role: string | null;
  isManager: boolean;
  joinedAt: string | null;
}

export interface PersonChannelMembership {
  id: string;
  name: string;
  role: string | null;
  isManager?: boolean;
  /** public / private / dm；旧数据可能缺省 */
  type?: "public" | "private" | "dm";
  description?: string | null;
  /** DM 对端 handle，用于跳转 /dm/:handle */
  peerHandle?: string | null;
}

export interface PersonComputerRef {
  id: string;
  name: string;
  online: boolean;
}

export interface PersonStats {
  messages: number;
  tasksOpen: number;
  tasksDone: number;
  costUsd?: number | null;
}

export interface PersonProfile {
  type: MemberType;
  id: string;
  handle: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastMessageAt?: string | null;
  runtime?: string;
  model?: string;
  /** @deprecated 用 presence；值为值班且办公室开门 */
  isOnline?: boolean;
  duty?: AgentDuty;
  presence?: AgentPresence;
  ownedByMe?: boolean;
  computer?: PersonComputerRef | null;
  channel?: PersonChannelContext | null;
  channels: PersonChannelMembership[];
  channelsHasMore?: boolean;
  channelsCapped?: boolean;
}

// ---- 用户 ----

export interface User {
  id: UUID;
  handle: string; // @mention 唯一标识
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
  name: string; // stable @handle
  displayName: string;
  description?: string;
  avatarUrl?: string;
  status: AgentStatus;
  duty?: AgentDuty;
  presence?: AgentPresence;
  runtime: string; // "claude" | "codex" | "kimi" | ...
  model: string;
  capabilities: string[]; // ["send", "read", "tasks", ...]
  createdAt: ISO8601;
}

// ---- 任务 ----

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";

export interface Task {
  number: number; // 频道内自增
  messageId: UUID;
  channelId: UUID;
  title: string;
  status: TaskStatus;
  assignee?: UUID; // agent ID
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

// ---- 提醒 ----

export type ReminderStatus = "scheduled" | "fired" | "canceled";

export type RepeatRule = string; // "every:15m" | "daily@09:00" | "weekly:mon,fri@09:00"

// T2:kind='patrol' 时为 agent 定时巡检任务(设计:docs/2026-08-19/02-t2-agent-patrol-design.md)
export type ReminderKind = "reminder" | "patrol";

export interface Reminder {
  id: UUID;
  ownerId: UUID;
  kind?: ReminderKind;
  title: string;
  instructions?: string;
  fireAt: ISO8601;
  repeatRule?: RepeatRule;
  channelRef?: string;
  anchorMsgId?: UUID;
  status: ReminderStatus;
  paused?: boolean;
  consecutiveSilent?: number;
  maxConsecutiveSilent?: number;
  createdAt: ISO8601;
}

export type ReminderEventType =
  | "created"
  | "fired"
  | "snoozed"
  | "updated"
  | "canceled"
  | "dismissed"
  | "paused"
  | "resumed"
  | "auto_paused";

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
  tokenPrefix: string; // "sk_machine_"
  scope: Record<string, unknown>;
  expiresAt?: ISO8601;
  revokedAt?: ISO8601;
}

// ---- 操作卡片 ----

export type ActionType = "channel:create" | "agent:create";

export interface ActionCard {
  id: UUID;
  channelId: UUID;
  createdBy: UUID; // agent ID
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

// ---- WebSocket 线协议 ----
// 2026-08-20 按实际收发代码重写（S2.2）：依据 packages/server/src/ws/handler.ts 与
// packages/daemon/src/daemon-core.ts 的真实线协议，四个 union 按方向命名。
// 心跳走 WS 协议层（ws.ping()/pong 事件）；JSON ping/pong 为遗留兼容（daemon 收到
// JSON ping 回 pong；browser 发的 pong 被 server 忽略）。
// ⚠️ 曾用名 WsServerMessage/WsClientMessage 已与实际漂移（agent:deliver:ack、
// reminder.upsert/cancel/snapshot、agent:activity_probe 均不在线上），保留为
// deprecated 别名，web 过渡期后删除。

// ---------- 共享构件 ----------

/** agent:deliver 的 message 载荷（messages.ts / agents-dispatch.ts / agents-messages.ts 组装） */
export interface WsDeliverMessage {
  id: UUID;
  seq: number;
  /** "#general" 或 "dm:<uuid>"（daemon 端剥 # 前缀解析频道名） */
  channelId: string;
  senderId: UUID;
  senderName: string;
  senderHandle?: string;
  senderType: MessageType;
  content: string;
  time: ISO8601;
  threadId?: UUID | null;
  attachments?: AttachmentRef[];
  /** O15：回显给发送方，对账本地待确认消息 */
  clientNonce?: string;
  /** server 预过滤的「有权回应的 agent」handle 列表；空数组 = 有人被@但无人有权回应 */
  mentionAgents?: string[];
  /** DM 标记 + agent 接收方（无需 @ 唤醒） */
  dm?: boolean;
  dmAgentRecipients?: string[];
  dmPeerHandle?: string;
  /** 经理/worker 派发通知的显式路由目标（绕开 daemon 防自环） */
  forceDeliverTo?: string;
  /** T8：无 @ 顶层消息的单选分诊经理（server 按 is_manager 最早加入者选出） */
  triageAgents?: string[];
}

/** B1 结构化观察帧——规范定义在 shared，daemon agent-observation.ts 从此 re-export */
export interface ObservationFrame {
  agentName: string;
  /** 总线内自增序号（跨 agent 全局唯一，便于排序/去重） */
  seq: number;
  timestamp: number;
  kind: "system" | "text" | "thinking" | "tool_use" | "tool_result" | "turn_start" | "turn_end" | "error";
  /** 回合标识：stream-json 里 assistant message 的 id（没有则为 null） */
  turnId: string | null;
  payload: {
    text?: string;
    toolName?: string;
    toolUseId?: string;
    toolInput?: unknown;
    /** turn_end 时的结果摘要（耗时/cost/成功与否） */
    summary?: string;
  };
}

/** agent:start 的 config 变体（agents.ts 创建 / agents-public.ts PATCH） */
export interface WsAgentStartConfig {
  name?: string;
  displayName?: string;
  description?: string;
  runtime?: string;
  model?: string;
  runtime_profile?: { runtime?: string; model?: string };
}

/** agent:start 的 agent 变体（agents-public.ts 公开注册） */
export interface WsAgentStartAgent {
  id?: UUID;
  name?: string;
  displayName?: string;
  description?: string;
  runtime?: string;
  model?: string;
  runtime_profile?: { runtime?: string; model?: string };
}

/** reminder.fire 的 reminder 载荷（reminder-scheduler.ts 组装） */
export interface WsReminderFire {
  id: UUID;
  title: string;
  channel: string | null;
  kind: string; // "reminder" | "patrol"
  instructions: string | null;
}

/** notification.new 的 notification 载荷（notifications.ts createNotification 组装） */
export interface WsNotification {
  id: UUID;
  type: string;
  actorId?: UUID;
  actorName?: string | null;
  channelId?: UUID | null;
  messageId?: UUID | null;
  title: string;
  body?: string | null;
  metadata?: unknown;
  read?: boolean;
  createdAt?: ISO8601;
}

// ---------- server → daemon ----------

export type WsToDaemonMessage =
  | { type: "connected"; serverTime: ISO8601 }
  | { type: "agent:start"; agentId?: UUID; agent?: WsAgentStartAgent; config?: WsAgentStartConfig }
  | { type: "agent:stop"; agentId: UUID }
  | { type: "agent:duty"; agentId: UUID; name: string; duty: AgentDuty }
  | { type: "agent:deliver"; seq?: number; message: WsDeliverMessage }
  | { type: "reminder.fire"; agentId: UUID; reminder: WsReminderFire }
  | { type: "terminal:watch"; agentName: string }
  | { type: "terminal:unwatch"; agentName: string }
  | { type: "terminal:history"; agentName: string }
  | { type: "terminal:resize"; agentName: string; cols?: number; rows?: number }
  | { type: "workspace:read"; requestId: string; agentName: string; path?: string }
  | { type: "ping" };

// ---------- daemon → server ----------

/** Computer 能力地图：已装 / 未装 / 已装但平台未接线（P0 spawn 仅 claude） */
export type RuntimeProbeStatus = "installed" | "not_installed" | "installed_unsupported";

export interface RuntimeProbe {
  id: string;
  status: RuntimeProbeStatus;
  version?: string;
}

export const RUNTIME_CATALOG_IDS = ["claude", "codex", "gemini", "opencode"] as const;
export type RuntimeCatalogId = (typeof RUNTIME_CATALOG_IDS)[number];

/** P0 已接线、创建 picker 可收的 runtime */
export const WIRED_RUNTIME_IDS = ["claude"] as const;

export type WsFromDaemonMessage =
  | {
      type: "ready";
      capabilities: string[];
      /** 新 daemon 发 RuntimeProbe[]；旧 daemon / 测试仍可能发 string[]，server 会归一化 */
      runtimes: RuntimeProbe[] | string[];
      hostname: string;
      daemonVersion: string;
      os?: string;
      arch?: string;
    }
  | { type: "agent:status"; agentId: string; agentName: string; status: string; detail: string }
  | { type: "agent:delivery-queued"; agentName: string; channelName: string }
  | { type: "agent:delivery-dead-letter"; agentName: string; channelName: string; error: string }
  | {
      type: "agent:tool-call";
      agentName: string;
      agentId: string;
      toolName: string | null;
      toolUseId: string | null;
      status: "pending" | "completed";
      text: string | null;
      time: ISO8601;
    }
  | { type: "terminal:frame"; agentName: string; screen: string; status: string; time: ISO8601 }
  | { type: "terminal:obs-frame"; agentName: string; frame: ObservationFrame }
  | { type: "terminal:obs-history"; agentName: string; frames: ObservationFrame[] }
  | { type: "terminal:history"; agentName: string; text: string }
  | {
      type: "agent:progress";
      agentName: string;
      channelName: string;
      headline: string;
      phase: "start" | "update" | "end";
    }
  | {
      type: "workspace:result";
      requestId: string;
      agentName: string;
      exists: boolean;
      files?: { path: string; bytes: number; mtime: string }[];
      path?: string;
      content?: string;
      bytes?: number;
      error?: string;
    }
  | { type: "pong" };

// ---------- server → browser ----------

export type WsToBrowserMessage =
  | { type: "connected"; time: ISO8601 }
  | { type: "agent:deliver"; seq?: number; message: WsDeliverMessage }
  | { type: "message:update"; message: { id: UUID; content: string; editedAt: ISO8601 } }
  | { type: "message:delete"; message: { id: UUID } }
  | { type: "notification.new"; notification: WsNotification }
  // ---- 以下为 daemon 上报、server 中继 ----
  | { type: "agent:status"; agentId: string; agentName: string; status: string; detail: string }
  | {
      type: "agent:presence";
      agentId: UUID;
      agentName: string;
      duty: AgentDuty;
      computerOnline: boolean;
      presence: AgentPresence;
    }
  | { type: "agent:delivery-queued"; agentName: string; channelName: string }
  | { type: "agent:delivery-dead-letter"; agentName: string; channelName: string; error: string }
  | { type: "terminal:history"; agentName: string; text: string }
  | { type: "terminal:obs-history"; agentName: string; frames: ObservationFrame[] }
  | { type: "terminal:frame"; agentName: string; screen: string; status: string; time: ISO8601 }
  | { type: "terminal:obs-frame"; agentName: string; frame: ObservationFrame }
  | {
      type: "agent:progress";
      agentName: string;
      channelName: string;
      headline: string;
      phase: "start" | "update" | "end";
    }
  | {
      type: "workspace:result";
      requestId: string;
      agentName: string;
      exists: boolean;
      files?: { path: string; bytes: number; mtime: string }[];
      path?: string;
      content?: string;
      bytes?: number;
      error?: string;
    };

// ---------- browser → server ----------

export type WsFromBrowserMessage =
  | { type: "terminal:watch"; agentName: string }
  | { type: "terminal:unwatch"; agentName: string }
  | { type: "terminal:history"; agentName: string }
  | { type: "terminal:resize"; agentName: string; cols?: number; rows?: number }
  | { type: "pong" };

export interface AgentWorkspaceFile {
  path: string;
  bytes: number;
  mtime: string;
}

export interface AgentWorkspaceSnapshot {
  exists: boolean;
  files: AgentWorkspaceFile[];
  path?: string;
  content?: string;
  bytes?: number;
  error?: string;
}

/** broadcast(channelId, …) 允许的频道广播事件子集（server 路由组包发频道成员） */
export type WsChannelBroadcast = Extract<
  WsToBrowserMessage,
  { type: "agent:deliver" | "message:update" | "message:delete" }
>;

// ---------- 兼容别名（@deprecated：web 过渡期保留，后续删除）----------

/** @deprecated 用 WsToBrowserMessage */
export type WsServerMessage = WsToBrowserMessage;
/** @deprecated 用 WsFromBrowserMessage */
export type WsClientMessage = WsFromBrowserMessage;
/** @deprecated 用 WsToBrowserMessage["type"] */
export type WsServerMessageType = WsServerMessage["type"];
/** @deprecated 用 WsFromBrowserMessage["type"] */
export type WsClientMessageType = WsClientMessage["type"];

export {
  type AgentDuty,
  type AgentPresence,
  type AgentRuntimeHint,
  agentListFields,
  composePresence,
  PRESENCE_LABEL,
  parseAgentDuty,
  presenceIsOnline,
} from "./presence.js";
export {
  channelProgressEnabled,
  DEFAULT_PROGRESS_THROTTLE_MS,
  formatProgressMessage,
  isProgressContent,
  labelTool,
  PROGRESS_PREFIX,
  type ProgressFrame,
  type ProgressSnapshot,
  type ProgressToolItem,
  readProgressThrottleMs,
  summarizeProgress,
} from "./progress.js";

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
  before?: number; // seq
  after?: number;
  around?: UUID; // message UUID
  limit?: number; // 默认 50
}
