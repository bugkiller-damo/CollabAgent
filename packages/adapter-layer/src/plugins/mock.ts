// ============================================================
// Mock 适配器 — 模拟渗透测试引擎
// 用于开发环境演示完整闭环
// ============================================================

import type {
  UUID, Asset, VulnerabilityType, SeverityLevel,
  AssetDiscoveryAdapter, AssetDiscoveryAdapterRequest, AssetDiscoveryAdapterResponse,
  VulnScanAdapter, VulnScanAdapterRequest, VulnScanAdapterResponse, VulnScanResult, ExternalVulnerability,
  PenetrationAdapter, PenetrationTaskRequest, PenetrationTaskResponse,
  PenetrationStatusResponse, PenetrationResultsResponse, PenetrationAction,
  PenetrationMessage,
  ComplianceAdapter, ComplianceCheckRequest, ComplianceCheckResponse,
  AdapterResult,
} from "@collabagent/shared";

const MOCK_DELAY_MS = 1500;

function delay<T>(value: T, ms = MOCK_DELAY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function rid(): UUID { return crypto.randomUUID(); }

function mockAssets(networkRange: string): Asset[] {
  const baseIP = networkRange.split("/")[0].split(".").slice(0, 3).join(".");
  return [
    { id: rid(), subsidiaryId: "00000000-0000-0000-0000-000000000000", ip: `${baseIP}.10`, hostname: "web-01", os: "Linux 5.4",
      openPorts: [22, 80, 443], services: [{ port: 22, protocol: "tcp", service: "OpenSSH", version: "8.0" }, { port: 80, protocol: "tcp", service: "nginx", version: "1.20" }, { port: 443, protocol: "tcp", service: "https", version: "1.20" }],
      fingerprints: {}, assetLevel: "core", tags: ["web", "dmz"], status: "active",
      discoveredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: rid(), subsidiaryId: "00000000-0000-0000-0000-000000000000", ip: `${baseIP}.20`, hostname: "db-01", os: "Linux 5.4",
      openPorts: [3306], services: [{ port: 3306, protocol: "tcp", service: "MySQL", version: "5.7" }],
      fingerprints: {}, assetLevel: "core", tags: ["db"], status: "active",
      discoveredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: rid(), subsidiaryId: "00000000-0000-0000-0000-000000000000", ip: `${baseIP}.30`, hostname: "app-01", os: "Linux 5.4",
      openPorts: [8080], services: [{ port: 8080, protocol: "tcp", service: "Tomcat", version: "9.0" }],
      fingerprints: {}, assetLevel: "important", tags: ["app"], status: "active",
      discoveredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  ];
}

function mockVulns(target: string): ExternalVulnerability[] {
  const ip = target.split("/")[0];
  return [
    { vulnId: rid(), cveId: "CVE-2024-LOG4J", title: "Apache Log4j 远程代码执行", cvssScore: 9.8, severity: "CRITICAL", affectedTarget: `${ip}:8080`, remediation: "升级 Log4j 至 2.17.1+" },
    { vulnId: rid(), cveId: "CVE-2023-NGINX", title: "Nginx 配置错误导致目录遍历", cvssScore: 6.5, severity: "MEDIUM", affectedTarget: `${ip}:80`, remediation: "关闭 nginx autoindex" },
    { vulnId: rid(), cveId: "CVE-2023-OPENSSH", title: "OpenSSH 信息泄露", cvssScore: 5.3, severity: "LOW", affectedTarget: `${ip}:22`, remediation: "升级 OpenSSH 至 9.0+" },
  ];
}

function mockPenVulns(target: string): NonNullable<PenetrationResultsResponse["vulnerabilities"]> {
  return mockVulns(target).map((v) => ({
    vulnId: v.vulnId, target: v.affectedTarget, cveId: v.cveId, title: v.title,
    cvssScore: v.cvssScore, severity: v.severity as SeverityLevel,
    vulnType: v.cveId?.includes("LOG4J") ? "RCE" as VulnerabilityType : v.cveId?.includes("NGINX") ? "PATH_TRAVERSAL" as VulnerabilityType : "INFO_LEAK" as VulnerabilityType,
    attackPath: { entryPoint: v.affectedTarget, chain: [{ step: 1, phase: "exploitation", action: v.title, status: "success", timestamp: new Date().toISOString() }], finalImpact: "攻击者可获得系统权限" },
    remediation: { immediate: v.remediation || "见安全建议" },
  }));
}

// ==================== 资产发现 ====================
export const mockAssetDiscovery: AssetDiscoveryAdapter = {
  async discover(request: AssetDiscoveryAdapterRequest): Promise<AdapterResult<AssetDiscoveryAdapterResponse>> {
    const result: AssetDiscoveryAdapterResponse = { discoveryId: rid(), status: "completed", assets: mockAssets(request.networkRange), totalFound: 3, executionTimeSeconds: 1 };
    return { success: true, data: await delay(result, 800), executionTimeMs: 800 };
  },
};

// ==================== 漏洞扫描 ====================
const vulnScanResults = new Map<string, VulnScanResult>();

export const mockVulnScan: VulnScanAdapter = {
  async scan(request: VulnScanAdapterRequest): Promise<AdapterResult<VulnScanAdapterResponse>> {
    const scanId = rid();
    const allVulns = request.targets.flatMap((t) => mockVulns(t));
    const result: VulnScanResult = { scanId, status: "completed", vulnerabilities: allVulns, totalVulnerabilities: allVulns.length, executionTimeSeconds: 2 };
    vulnScanResults.set(scanId, result);
    const r: VulnScanAdapterResponse = { scanId, status: "completed", progressPercent: 100, estimatedCompletion: new Date().toISOString() };
    return { success: true, data: await delay(r, 1200), executionTimeMs: 1200 };
  },
  async getResult(scanId: string): Promise<AdapterResult<VulnScanResult>> {
    const r = vulnScanResults.get(scanId);
    if (!r) return { success: false, error: { code: "NOT_FOUND", message: "scan not found", retryable: false }, executionTimeMs: 0 };
    return { success: true, data: r, executionTimeMs: 0 };
  },
};

// ==================== 渗透测试 ====================
const penResults = new Map<string, PenetrationResultsResponse>();

export const mockPenetration: PenetrationAdapter = {
  async createTask(request: PenetrationTaskRequest): Promise<AdapterResult<PenetrationTaskResponse>> {
    const taskRef = `mock-task-${rid()}`;
    const r: PenetrationTaskResponse = { taskRef, status: "accepted", estimatedCompletion: new Date(Date.now() + 10000).toISOString(), createdAt: new Date().toISOString() };
    setTimeout(() => {
      const vulns = request.targets.flatMap((t) => mockPenVulns(t.target));
      const crit = vulns.filter((v) => v.severity === "CRITICAL").length;
      const high = vulns.filter((v) => v.severity === "HIGH").length;
      const med = vulns.filter((v) => v.severity === "MEDIUM").length;
      const low = vulns.filter((v) => v.severity === "LOW").length;
      const result: PenetrationResultsResponse = {
        taskRef, status: "completed",
        summary: { totalVulnerabilities: vulns.length, critical: crit, high, medium: med, low, targetsScanned: request.targets.length, targetsBreached: crit > 0 ? 1 : 0, executionTimeSeconds: 8 },
        vulnerabilities: vulns,
        attackGraph: { nodes: request.targets.map((t, i) => ({ id: `t${i}`, type: i === 0 ? "entry" : "internal", status: crit > 0 && i === 0 ? "breached" : "scanned", ip: t.target })), edges: crit > 0 ? [{ from: "t0", to: "t1", method: "SSH key reuse", status: "success" }] : [] },
      };
      penResults.set(taskRef, result);
    }, 2500);
    return { success: true, data: r, executionTimeMs: 200 };
  },
  async getStatus(taskRef: string): Promise<AdapterResult<PenetrationStatusResponse>> {
    const r = penResults.get(taskRef);
    const status = r ? "completed" : "running";
    return { success: true, data: { taskRef, status, progress: { phase: "exploitation", percent: r ? 100 : 50, targetsCompleted: 1, targetsTotal: 1 }, findings: { critical: 1, high: 0, medium: 1, low: 1 }, lastActivity: new Date().toISOString() }, executionTimeMs: 0 };
  },
  async controlTask(taskRef: string, action: PenetrationAction): Promise<AdapterResult<{ status: string }>> {
    return { success: true, data: { status: action === "resume" ? "running" : action === "pause" ? "paused" : "terminated" }, executionTimeMs: 0 };
  },
  async getResults(taskRef: string): Promise<AdapterResult<PenetrationResultsResponse>> {
    const r = penResults.get(taskRef);
    if (!r) return { success: false, error: { code: "NOT_READY", message: "results not ready yet", retryable: true }, executionTimeMs: 0 };
    return { success: true, data: r, executionTimeMs: 0 };
  },
  async sendMessage(taskRef: string, message: PenetrationMessage): Promise<AdapterResult<{ messageId: UUID }>> {
    return { success: true, data: { messageId: rid() }, executionTimeMs: 50 };
  },
};

// ==================== 合规检查 ====================
export const mockCompliance: ComplianceAdapter = {
  async check(request: ComplianceCheckRequest): Promise<AdapterResult<ComplianceCheckResponse>> {
    const r: ComplianceCheckResponse = {
      checkId: rid(), standard: request.standard, status: "completed", overallCompliant: false,
      items: [
        { requirement: "身份鉴别", result: "pass", detail: "已启用密码复杂度策略" },
        { requirement: "访问控制", result: "fail", detail: "存在默认共享账号 guest", remediation: "禁用 guest 账户" },
        { requirement: "入侵防范", result: "pass", detail: "已部署主机入侵检测系统" },
      ],
      failCount: 1, executionTimeSeconds: 2,
    };
    return { success: true, data: await delay(r, 1000), executionTimeMs: 1000 };
  },
};

// ==================== 一键注册 ====================
export function registerMockAdapters(registry: { register(def: any, instance: any): void }): void {
  const ts = new Date().toISOString();
  const def = (id: string, name: string, type: any) => ({
    id, name, adapterType: type, provider: "mock", endpoint: "internal://mock",
    authType: "api_key", authConfig: {}, options: {}, healthStatus: "healthy", enabled: true,
    createdAt: ts, updatedAt: ts,
  });
  registry.register(def("00000000-0000-0000-0000-aaaaaaaaaaaa", "mock-asset-discovery", "asset_discovery"), mockAssetDiscovery);
  registry.register(def("00000000-0000-0000-0000-bbbbbbbbbbbb", "mock-vuln-scan", "vulnerability_scan"), mockVulnScan);
  registry.register(def("00000000-0000-0000-0000-cccccccccccc", "mock-penetration", "penetration"), mockPenetration);
  registry.register(def("00000000-0000-0000-0000-dddddddddddd", "mock-compliance", "compliance_check"), mockCompliance);
}
