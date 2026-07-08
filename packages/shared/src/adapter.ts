// ============================================================
// CollabAgent → 安全渗透测试平台 — 适配器接口定义
// 第三方安全服务 API 集成（适配器模式）
// ============================================================

import type { UUID, ISO8601 } from "./base.js";
import type { Asset, SeverityLevel, VulnerabilityType } from "./penetration.js";

// ---- 适配器类型 ----

export type AdapterType =
  | "asset_discovery"
  | "vulnerability_scan"
  | "penetration"
  | "compliance_check";

export type AdapterHealth = "unknown" | "healthy" | "degraded" | "unhealthy";

export type AuthType = "api_key" | "oauth" | "client_credential" | "basic";

// ---- 适配器注册 ----

export interface AdapterDefinition {
  id: UUID;
  name: string;
  adapterType: AdapterType;
  provider: string;
  endpoint?: string;
  authType: AuthType;
  authConfig: Record<string, unknown>;
  options: Record<string, unknown>;
  healthStatus: AdapterHealth;
  enabled: boolean;
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

export interface AdapterRegisterRequest {
  name: string;
  type: AdapterType;
  provider: string;
  endpoint?: string;
  authType: AuthType;
  authConfig: Record<string, unknown>;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

// ---- 适配器调用 ----

export interface AdapterCallOptions {
  timeoutSeconds: number;
  maxRetries: number;
  callbackUrl?: string;
}

export interface AdapterResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: AdapterError;
  executionTimeMs: number;
}

export interface AdapterError {
  code: string;
  message: string;
  retryable: boolean;
}

// ---- 资产发现适配器 ----

export interface AssetDiscoveryAdapter {
  discover(request: AssetDiscoveryAdapterRequest): Promise<AdapterResult<AssetDiscoveryAdapterResponse>>;
}

export interface AssetDiscoveryAdapterRequest {
  networkRange: string;
  options?: { timeoutSeconds?: number; maxResults?: number };
  callbackUrl?: string;
}

export interface AssetDiscoveryAdapterResponse {
  discoveryId: UUID;
  status: "running" | "completed" | "failed";
  assets: Asset[];
  totalFound: number;
  executionTimeSeconds: number;
}

// ---- 漏洞扫描适配器 ----

export interface VulnScanAdapter {
  scan(request: VulnScanAdapterRequest): Promise<AdapterResult<VulnScanAdapterResponse>>;
  getResult(scanId: string): Promise<AdapterResult<VulnScanResult>>;
}

export interface VulnScanAdapterRequest {
  targets: string[];
  scanTemplate: string;
  options?: { timeoutSeconds?: number };
  callbackUrl?: string;
}

export interface VulnScanAdapterResponse {
  scanId: UUID;
  status: "running" | "completed" | "failed";
  progressPercent: number;
  estimatedCompletion?: ISO8601;
}

export interface VulnScanResult {
  scanId: UUID;
  status: "completed" | "failed";
  vulnerabilities: ExternalVulnerability[];
  totalVulnerabilities: number;
  executionTimeSeconds: number;
}

export interface ExternalVulnerability {
  vulnId: string;
  cveId?: string;
  title: string;
  cvssScore: number;
  severity: SeverityLevel;
  affectedTarget: string;
  remediation?: string;
}

// ---- 渗透测试适配器 ----

export type PenetrationAction = "start" | "pause" | "resume" | "stop" | "terminate";

export interface PenetrationAdapter {
  createTask(request: PenetrationTaskRequest): Promise<AdapterResult<PenetrationTaskResponse>>;
  getStatus(taskRef: string): Promise<AdapterResult<PenetrationStatusResponse>>;
  controlTask(taskRef: string, action: PenetrationAction): Promise<AdapterResult<{ status: string }>>;
  getResults(taskRef: string): Promise<AdapterResult<PenetrationResultsResponse>>;
  sendMessage(taskRef: string, message: PenetrationMessage): Promise<AdapterResult<{ messageId: UUID }>>;
}

export interface PenetrationTaskRequest {
  taskType: string;
  targets: { target: string; hostname?: string; assetLevel?: string; networkRange?: string; credentials?: { username: string; password: string; note?: string }[] }[];
  scanProfile: string;
  maxConcurrency?: number;
  timeout?: number;
  allowedOperations?: string[];
  restrictedOperations?: string[];
  callbackUrl?: string;
}

export interface PenetrationTaskResponse {
  taskRef: string;
  status: string;
  estimatedCompletion?: ISO8601;
  createdAt: ISO8601;
}

export interface PenetrationStatusResponse {
  taskRef: string;
  status: string;
  progress: { phase: string; percent: number; targetsCompleted: number; targetsTotal: number };
  findings: { critical: number; high: number; medium: number; low: number };
  lastActivity: ISO8601;
}

export interface PenetrationResultsResponse {
  taskRef: string;
  status: string;
  summary: { totalVulnerabilities: number; critical: number; high: number; medium: number; low: number; targetsScanned: number; targetsBreached: number; executionTimeSeconds: number };
  vulnerabilities: { vulnId: string; target: string; cveId?: string; title: string; cvssScore: number; severity: SeverityLevel; vulnType: VulnerabilityType; attackPath: { entryPoint: string; chain: { step: number; phase: string; action: string; status: string; timestamp: ISO8601 }[]; finalImpact: string }; remediation: { immediate: string; workaround?: string } }[];
  attackGraph: { nodes: { id: string; type: string; status: string; ip: string }[]; edges: { from: string; to: string; method: string; status: string }[] };
}

export interface PenetrationMessage {
  targetAgent?: string;
  content: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

// ---- 合规检查适配器 ----

export interface ComplianceAdapter {
  check(request: ComplianceCheckRequest): Promise<AdapterResult<ComplianceCheckResponse>>;
}

export interface ComplianceCheckRequest {
  asset: { ip: string; hostname?: string; os?: string; services?: string[] };
  standard: string;
  callbackUrl?: string;
}

export interface ComplianceCheckResponse {
  checkId: UUID;
  standard: string;
  status: "completed" | "failed";
  overallCompliant: boolean;
  items: { requirement: string; result: "pass" | "fail" | "na"; detail: string; remediation?: string }[];
  failCount: number;
  executionTimeSeconds: number;
}

// ---- Webhook 回调 ----

export type CallbackEventType = "vulnerability_discovered" | "task_status_changed" | "agent_health_changed" | "circuit_breaker_triggered";

export interface WebhookCallback {
  eventId: UUID;
  eventType: CallbackEventType;
  taskId?: UUID;
  timestamp: ISO8601;
  payload: Record<string, unknown>;
}

export interface WebhookSignature {
  signature: string;
  eventId: string;
  timestamp: number;
}

// ---- OAuth 2.0 ----

export interface OAuthTokenRequest {
  clientId: string;
  clientSecret: string;
  grantType: "client_credentials";
  scope?: string;
}

export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope?: string;
}

// ---- 错误码 ----

export type AdapterErrorCode =
  | "INVALID_PARAMETERS" | "AUTHENTICATION_FAILED" | "OPERATION_NOT_ALLOWED"
  | "TASK_NOT_FOUND" | "TASK_STATE_CONFLICT" | "RATE_LIMIT_EXCEEDED"
  | "THIRD_PARTY_TIMEOUT" | "THIRD_PARTY_UNAVAILABLE"
  | "INTERNAL_ERROR" | "ENGINE_OVERLOADED";
