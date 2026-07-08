// ============================================================
// CollabAgent → 安全渗透测试平台 — 平台层类型定义
// 组织层级 / 多租户 / RBAC / 增强消息协议
// ============================================================

import type { UUID, ISO8601, AttachmentRef, Reaction } from "./base.js";
import type { SeverityLevel, NotificationChannel, ScanIntensity } from "./penetration.js";

// ---- 组织层级 ----

/** 组织层级：集团 / 子公司 */
export type OrgLevel = "group" | "subsidiary";

/** 组织状态 */
export type OrgStatus = "active" | "inactive" | "suspended";

/** 组织/服务器扩展（在现有 servers 表基础上扩展） */
export interface Org {
  id: UUID;
  name: string;
  level: OrgLevel;
  parentId?: UUID;
  status: OrgStatus;
  config?: OrgConfig;
  tags?: string[];
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

/** 监管策略配置 */
export interface OrgConfig {
  scanStrategy?: ScanStrategy;
  securityControl?: SecurityControlStrategy;
  caseDistribution?: CaseDistributionStrategy;
  alertReport?: AlertReportStrategy;
}

export interface ScanStrategy {
  interval: string;
  intensity: ScanIntensity;
  allowedPeriod?: string;
  thirdPartyApi: boolean;
}


export interface SecurityControlStrategy {
  forbiddenOperations: string[];
  autoExecThreshold: number;
  approvalThreshold: number;
  circuitBreakerLatencyMs: number;
}

export interface CaseDistributionStrategy {
  pushMatchThreshold: number;
  forcePushSeverity: SeverityLevel[];
  autoPullCritical: boolean;
}

export interface AlertReportStrategy {
  heartbeatInterval: number;
  summaryInterval: number;
  alertChannels: NotificationChannel[];
  alertThreshold: SeverityLevel;
}

// ---- 子公司 ----

/** 子公司自主管理平台节点 */
export interface SubsidiaryNode {
  id: UUID;
  groupId: UUID;
  name: string;
  status: OrgStatus;
  agentCount: number;
  assetCount: number;
  lastHeartbeat?: ISO8601;
  config: OrgConfig;
  createdAt: ISO8601;
}

// ---- RBAC 角色权限 ----

export type PlatformRole =
  | "system_admin"
  | "security_analyst"
  | "pen_tester"
  | "approval_admin"
  | "auditor"
  | "subsidiary_admin"
  | "member";

export type ResourceType =
  | "asset" | "task" | "case" | "alert"
  | "agent" | "user" | "admin" | "config" | "audit";

export type ResourceAction =
  | "create" | "read" | "update" | "delete"
  | "approve" | "control" | "export" | "audit";

export interface RoleDefinition {
  id: UUID;
  name: PlatformRole;
  description: string;
  permissions: RolePermission[];
  isSystem: boolean;
}

export interface RolePermission {
  resource: ResourceType;
  action: ResourceAction;
  constraint: "allow" | "deny";
  scope: "global" | "subsidiary" | "self";
}

// ---- 增强消息协议 ----

/** 智能体消息类型 */
export type AgentMessageType =
  | "policy_publish"
  | "global_command"
  | "status_report"
  | "vulnerability_alert"
  | "case_notify"
  | "coordination_req"
  | "heartbeat"
  | "status_change"
  | "mention_notify"
  | "ack";

/** 消息优先级 */
export type MessagePriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** 内容类型 */
export type ContentType =
  | "text/plain"
  | "text/markdown"
  | "application/json"
  | "reference";

/** ACK 状态 */
export type AckStatus = "received" | "processed" | "rejected";

/** 增强消息体 */
export interface AgentMessage {
  messageId: UUID;
  senderId: UUID;
  senderType: "agent" | "human" | "system";
  receiverId: UUID;
  channelType: ChannelType;
  messageType: AgentMessageType;
  contentType: ContentType;
  content: string;
  priority: MessagePriority;
  mentionIds?: UUID[];
  threadId?: UUID;
  threadRootId?: UUID;
  attachments?: AttachmentRef[];
  reactions?: Reaction[];
  editHistory?: EditHistoryEntry[];
  traceId: string;
  timestamp: ISO8601;
}

export interface EditHistoryEntry {
  editedAt: ISO8601;
  previousContent: string;
}

/** 扩展频道类型 */
export type ChannelType = "public" | "private" | "dm" | "group_dm";

/** 扩展频道 */
export interface PlatformChannel {
  id: UUID;
  orgId: UUID;
  name: string;
  type: ChannelType;
  description?: string;
  memberCount: number;
  unreadCount?: number;
  archived: boolean;
  createdAt: ISO8601;
}

// ---- 智能体在线状态 ----

export type AgentOnlineStatus = "online" | "offline" | "busy";

export interface AgentPresence {
  agentId: UUID;
  status: AgentOnlineStatus;
  hostname?: string;
  daemonVersion?: string;
  runtimes?: string[];
  connectedAt?: ISO8601;
  lastHeartbeat: ISO8601;
}

// ---- 离线消息 ----

export interface PendingMessage {
  message: AgentMessage;
  expireAt: ISO8601;
  retryCount: number;
  lastAttempt?: ISO8601;
}

// ---- 审计日志 ----

export interface AuditLogEntry {
  id: UUID;
  subsidiaryId?: UUID;
  actorId: UUID;
  actorType: "human" | "agent" | "system";
  action: string;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  traceId?: string;
  createdAt: ISO8601;
}

// ---- 双平面通信 ----

export interface DualChannelMessage {
  messageId: UUID;
  senderId: string;
  seqNum: number;
  channel: "collaboration" | "api_direct";
  payload: Record<string, unknown>;
  timestamp: ISO8601;
}

export interface DualChannelConflict {
  messageId: UUID;
  collaborationPayload?: Record<string, unknown>;
  apiDirectPayload?: Record<string, unknown>;
  collaboratonSeq: number;
  apiDirectSeq: number;
  resolution: "api_priority" | "collab_priority" | "manual";
  resolvedAt: ISO8601;
}
