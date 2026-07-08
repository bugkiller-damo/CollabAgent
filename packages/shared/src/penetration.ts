// ============================================================
// CollabAgent → 安全渗透测试平台 — 渗透业务类型定义
// 资产 / 渗透任务 / 漏洞 / 攻击图 / 病例库 / 告警
// ============================================================

import type { UUID, ISO8601 } from "./base.js";

// ---- 通用枚举 ----

export type SeverityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type VulnerabilityType =
  | "RCE" | "SQLI" | "XSS" | "PRIVESC" | "LATERAL_MOVE"
  | "SSRF" | "PATH_TRAVERSAL" | "FILE_UPLOAD" | "INFO_LEAK"
  | "AUTH_BYPASS" | "INSECURE_CONFIG" | "OTHER";

export type NotificationChannel = "email" | "im" | "webhook" | "in_app";

// ---- 资产管理 ----

export type AssetLevel = "core" | "important" | "general";

export type AssetStatus = "active" | "changed" | "deprecated";

export interface Asset {
  id: UUID;
  subsidiaryId: UUID;
  ip: string;
  hostname?: string;
  domain?: string;
  os?: string;
  openPorts: number[];
  services: ServiceInfo[];
  fingerprints: Record<string, unknown>;
  assetLevel: AssetLevel;
  tags: string[];
  status: AssetStatus;
  discoveredAt: ISO8601;
  lastSeenAt: ISO8601;
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

export interface ServiceInfo {
  port: number;
  protocol: "tcp" | "udp";
  service: string;
  version?: string;
  banner?: string;
}

export type ScanIntensity = "quick" | "standard" | "deep";

export interface AssetDiscoveryRequest {
  networkRange: string;
  intensity: ScanIntensity;
  adapter?: string;
  callbackUrl?: string;
}

export interface AssetDiscoveryResult {
  discoveryId: UUID;
  adapter: string;
  status: "running" | "completed" | "failed";
  assets: Asset[];
  totalFound: number;
  executionTimeSeconds: number;
}

// ---- 渗透任务 ----

export type TaskStatus =
  | "pending" | "queued" | "running" | "paused"
  | "completed" | "failed" | "terminated" | "cancelled";

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type TaskType =
  | "full_penetration"
  | "vulnerability_scan"
  | "compliance_check"
  | "re_test"
  | "quick_scan";

export interface TaskTarget {
  target: string;
  hostname?: string;
  assetLevel: AssetLevel;
  networkRange?: string;
  credentials?: TargetCredential[];
}

export interface TargetCredential {
  username: string;
  password: string;
  note?: string;
}

export interface PenetrationTask {
  id: UUID;
  subsidiaryId: UUID;
  taskType: TaskType;
  taskName: string;
  status: TaskStatus;
  priority: TaskPriority;
  scanProfile: ScanIntensity;
  targets: TaskTarget[];
  allowedOperations: string[];
  restrictedOperations: string[];
  maxConcurrency: number;
  timeoutSeconds: number;
  checkpoints: TaskCheckpoint[];
  progressPercent: number;
  totalTargets: number;
  completedTargets: number;
  findingsSummary: VulnerabilitySummary;
  engineRef?: string;
  callbackUrl?: string;
  idempotencyKey?: string;
  createdBy: UUID;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  startedAt?: ISO8601;
  completedAt?: ISO8601;
}

export interface TaskCheckpoint {
  phase: string;
  state: Record<string, unknown>;
  savedAt: ISO8601;
}

export interface VulnerabilitySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface CreateTaskRequest {
  idempotencyKey: string;
  taskType: TaskType;
  taskName: string;
  targets: TaskTarget[];
  scanProfile: ScanIntensity;
  maxConcurrency?: number;
  timeout?: number;
  priority: TaskPriority;
  allowedOperations?: string[];
  restrictedOperations?: string[];
  callbackUrl?: string;
}

export type TaskControlAction = "pause" | "resume" | "stop" | "terminate";

export interface TaskControlRequest {
  action: TaskControlAction;
  reason?: string;
}

export interface TaskListQuery {
  page?: number;
  pageSize?: number;
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  taskType?: TaskType | TaskType[];
  createdAfter?: ISO8601;
  createdBefore?: ISO8601;
  sort?: "created_at" | "updated_at" | "priority";
  order?: "asc" | "desc";
}

// ---- 渗透结果 ----

export interface PenetrationResult {
  id: UUID;
  taskId: UUID;
  target: string;
  hostname?: string;
  vulnId: string;
  title: string;
  cvssScore: number;
  severity: SeverityLevel;
  vulnType: VulnerabilityType;
  affectedComponent?: AffectedComponent;
  attackPath: AttackPath;
  exploitEvidence?: ExploitEvidence;
  remediation: Remediation;
  discoveredAt: ISO8601;
}

export interface AffectedComponent {
  name: string;
  versionRange?: string;
  type: "os" | "middleware" | "application" | "library";
}

export interface AttackPath {
  entryPoint: string;
  chain: AttackStep[];
  finalImpact: string;
  chainDepth: number;
}

export interface AttackStep {
  step: number;
  phase: "exploitation" | "privilege_escalation" | "lateral_movement";
  action: string;
  agent: "execution" | "privilege" | "lateral_move";
  status: "success" | "failed" | "skipped";
  timestamp: ISO8601;
}

export interface ExploitEvidence {
  pocSummary?: string;
  pocAccessLevel?: "public" | "restricted" | "confidential";
  verificationRef?: string;
}

export interface Remediation {
  immediate: string;
  workaround?: string;
  longTerm?: string;
}

// ---- 攻击图 ----

export interface AttackGraph {
  taskId: UUID;
  incremental: boolean;
  nodes: AttackGraphNode[];
  edges: AttackGraphEdge[];
  generatedAt: ISO8601;
}

export interface AttackGraphNode {
  id: string;
  type: "entry" | "internal" | "target";
  status: "scanned" | "breached" | "attempted" | "unreachable";
  ip: string;
  hostname?: string;
  breachedAt?: ISO8601;
}

export interface AttackGraphEdge {
  from: string;
  to: string;
  method: string;
  status: "success" | "failed" | "in_progress";
  discoveredAt: ISO8601;
}

// ---- 病例库 ----

export type CaseStatus =
  | "draft" | "pending_review" | "published" | "rejected" | "archived";

export type CaseAction =
  | "approve" | "reject" | "archive" | "revise" | "mark_fixed";

export interface CaseEntry {
  id: UUID;
  subsidiaryId: UUID;
  status: CaseStatus;
  version: number;
  title: string;
  cveId?: string;
  cvssScore: number;
  severity: SeverityLevel;
  vulnType: VulnerabilityType;
  affectedComponent?: AffectedComponent;
  tags: string[];
  entryPoint?: string;
  chainSummary?: string;
  finalImpact?: string;
  pocSummary?: string;
  pocAccessLevel?: "public" | "restricted" | "confidential";
  verificationRef?: string;
  remediationImmediate?: string;
  remediationWorkaround?: string;
  remediationLongTerm?: string;
  affectedFingerprints: AssetFingerprint[];
  distributionStatus: DistributionStatus;
  relatedCaseIds: string[];
  reviewerId?: UUID;
  reviewComment?: string;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  publishedAt?: ISO8601;
}

export interface AssetFingerprint {
  os?: string;
  middleware?: string;
  app?: string;
  subsidiaryId: UUID;
}

export interface DistributionStatus {
  totalPushed: number;
  confirmedFixed: number;
  notApplicable: number;
  pending: number;
}

export interface CaseCreateRequest {
  subsidiaryId: UUID;
  caseData: {
    basicInfo: {
      title: string;
      cveId?: string;
      cvssScore: number;
      severity: SeverityLevel;
      vulnType: VulnerabilityType;
      affectedComponent?: AffectedComponent;
      tags?: string[];
    };
    attackPath?: {
      entryPoint: string;
      chainSummary: string;
      finalImpact: string;
    };
    exploitEvidence?: {
      pocSummary?: string;
      verificationRef?: string;
    };
    remediation: {
      immediate: string;
      workaround?: string;
      longTerm?: string;
    };
    affectedAssets?: AssetFingerprint[];
  };
}

export interface CaseSearchQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  severity?: SeverityLevel | SeverityLevel[];
  vulnType?: VulnerabilityType | VulnerabilityType[];
  cveId?: string;
  tag?: string | string[];
  subsidiaryId?: UUID;
  status?: CaseStatus | CaseStatus[];
  createdAfter?: ISO8601;
  createdBefore?: ISO8601;
  sortBy?: "created_at" | "cvss_score" | "share_count";
  order?: "asc" | "desc";
}

// ---- 告警 ----

export type AlertStatus = "unacknowledged" | "acknowledged" | "resolved";

export interface AlertRule {
  id: UUID;
  subsidiaryId?: UUID;
  name: string;
  description?: string;
  severity: SeverityLevel;
  metric: string;
  condition: AlertCondition;
  channels: NotificationChannel[];
  notifyIntervalMin: number;
  enabled: boolean;
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

export interface AlertCondition {
  operator: ">=" | "<=" | "==" | ">" | "<";
  threshold: number;
  windowSeconds: number;
}

export interface AlertRecord {
  id: UUID;
  ruleId: UUID;
  subsidiaryId?: UUID;
  severity: SeverityLevel;
  title: string;
  detail?: string;
  source?: string;
  status: AlertStatus;
  channelsUsed: NotificationChannel[];
  acknowledgedAt?: ISO8601;
  acknowledgedBy?: UUID;
  resolvedAt?: ISO8601;
  traceId?: string;
  createdAt: ISO8601;
}

export interface AlertRuleCreateRequest {
  name: string;
  description?: string;
  severity: SeverityLevel;
  metric: string;
  condition: AlertCondition;
  channels: NotificationChannel[];
  notifyIntervalMin?: number;
  enabled?: boolean;
}

// ---- 分页 ----

export interface Pagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}
