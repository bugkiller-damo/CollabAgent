// ============================================================
// Phase 2: v1 API 集成测试
// 资产 / 渗透任务 / 病例库 / 告警规则
// ============================================================

import { describe, it, expect, afterAll } from "vitest";
import { api, registerUser, cleanupTestData, closeSql } from "./helpers.js";

const SUBSIDIARY_ID = "a319db9b-6f52-43e6-b6e2-563e75860636";
let assetId = "";
let taskId = "";
let caseId = "";
let ruleId = "";

afterAll(async () => { await cleanupTestData(); await closeSql(); });

// ==================== 资产管理 ====================

describe("v1 /assets", () => {
  it("POST /assets 创建资产", async () => {
    const r = await api("/api/v1/assets", { method: "POST", token: "dev-token",
      body: { subsidiaryId: SUBSIDIARY_ID, ip: "10.0.0.1", hostname: "web-test", os: "Linux 5.4",
        openPorts: [80, 443], services: [{ port: 80, service: "nginx" }], assetLevel: "core", tags: ["web", "test"] } });
    expect(r.status).toBe(200);
    expect(r.data.asset.id).toBeTruthy();
    expect(r.data.asset.hostname).toBe("web-test");
    assetId = r.data.asset.id;
  });

  it("POST /assets upsert same IP", async () => {
    const r = await api("/api/v1/assets", { method: "POST", token: "dev-token",
      body: { subsidiaryId: SUBSIDIARY_ID, ip: "10.0.0.1", hostname: "web-updated",
        openPorts: [80, 443, 8080], assetLevel: "core", tags: ["web", "prod"] } });
    expect(r.status).toBe(200);
    expect(r.data.asset.hostname).toBe("web-updated");
    expect(r.data.asset.id).toBe(assetId);
  });

  it("GET /assets 列表", async () => {
    const r = await api("/api/v1/assets", { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.assets.length).toBeGreaterThanOrEqual(1);
    expect(r.data.pagination).toHaveProperty("totalCount");
  });

  it("GET /assets?q= 搜索", async () => {
    const r = await api("/api/v1/assets?q=web-updated", { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.assets.length).toBe(1);
  });

  it("GET /assets/:id 详情", async () => {
    const r = await api(`/api/v1/assets/${assetId}`, { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.asset.id).toBe(assetId);
  });

  it("PATCH /assets/:id 更新", async () => {
    const r = await api(`/api/v1/assets/${assetId}`, { method: "PATCH", token: "dev-token",
      body: { hostname: "web-patched", os: "Linux 6.0" } });
    expect(r.status).toBe(200);
    expect(r.data.asset.hostname).toBe("web-patched");
  });

  it("POST /assets/import 批量导入", async () => {
    const r = await api("/api/v1/assets/import", { method: "POST", token: "dev-token",
      body: { subsidiaryId: SUBSIDIARY_ID,
        assets: [{ ip: "10.0.0.10", hostname: "batch-01", os: "Windows", assetLevel: "important" },
                 { ip: "10.0.0.11", hostname: "batch-02", os: "Linux", assetLevel: "general" }] } });
    expect(r.status).toBe(200);
    expect(r.data.imported).toBe(2);
  });

  it("GET /assets 404", async () => {
    const r = await api("/api/v1/assets/00000000-0000-0000-0000-000000000000", { token: "dev-token" });
    expect(r.status).toBe(404);
  });
});

// ==================== 渗透任务管理 ====================

describe("v1 /tasks", () => {
  it("POST /tasks 创建任务", async () => {
    const r = await api("/api/v1/tasks", { method: "POST", token: "dev-token",
      body: { taskType: "vulnerability_scan", taskName: "test-scan",
        targets: [{ target: "10.0.0.1", assetLevel: "core" }], scanProfile: "standard", priority: "HIGH" } });
    expect(r.status).toBe(200);
    expect(r.data.task.status).toBe("pending");
    taskId = r.data.task.id;
  });

  it("POST /tasks 幂等性", async () => {
    const r = await api("/api/v1/tasks", { method: "POST", token: "dev-token",
      body: { idempotencyKey: "dup-key-001", taskType: "quick_scan", taskName: "idempotent", targets: [{ target: "10.0.0.2" }] } });
    const r2 = await api("/api/v1/tasks", { method: "POST", token: "dev-token",
      body: { idempotencyKey: "dup-key-001", taskType: "quick_scan", taskName: "idempotent", targets: [{ target: "10.0.0.2" }] } });
    expect(r2.data.task.id).toBe(r.data.task.id);
  });

  it("GET /tasks 列表", async () => {
    const r = await api("/api/v1/tasks", { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /tasks/:id 详情", async () => {
    const r = await api(`/api/v1/tasks/${taskId}`, { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.task.id).toBe(taskId);
  });

  it("GET /tasks/:id/status", async () => {
    const r = await api(`/api/v1/tasks/${taskId}/status`, { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("pending");
    expect(r.data.progress).toHaveProperty("percent");
  });

  it("POST /tasks/:id/control pending→pause 409", async () => {
    const r = await api(`/api/v1/tasks/${taskId}/control`, { method: "POST", token: "dev-token", body: { action: "pause" } });
    expect(r.status).toBe(409);                                    // pending 不能 pause
  });

  it("GET /tasks/:id/results 空结果", async () => {
    const r = await api(`/api/v1/tasks/${taskId}/results`, { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.vulnerabilities).toEqual([]);
  });

  it("POST /tasks/:id/msg 发消息", async () => {
    const r = await api(`/api/v1/tasks/${taskId}/msg`, { method: "POST", token: "dev-token", body: { content: "pause" } });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("delivered");
  });

  it("GET /tasks/:id/logs", async () => {
    const r = await api(`/api/v1/tasks/${taskId}/logs`, { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.logs)).toBe(true);
  });

  it("GET /tasks/:id/attack-graph 无图 404", async () => {
    const r = await api(`/api/v1/tasks/${taskId}/attack-graph`, { token: "dev-token" });
    expect(r.status).toBe(404);
  });

  it("POST /tasks 必填校验", async () => {
    const r = await api("/api/v1/tasks", { method: "POST", token: "dev-token", body: {} });
    expect(r.status).toBe(400);
  });

  it("POST /tasks/batch 批量创建", async () => {
    const r = await api("/api/v1/tasks/batch", { method: "POST", token: "dev-token",
      body: { operations: [{ action: "create", task: { taskType: "re_test", taskName: "batch-1", targets: [{ target: "10.0.0.3" }] } },
                           { action: "create", task: { taskType: "re_test", taskName: "batch-2", targets: [{ target: "10.0.0.4" }] } }] } });
    expect(r.status).toBe(200);
    expect(r.data.results.length).toBe(2);
    expect(r.data.failedCount).toBe(0);
  });
});

// ==================== 病例库 ====================

describe("v1 /cases", () => {
  it("POST /cases 上报", async () => {
    const r = await api("/api/v1/cases", { method: "POST", token: "dev-token",
      body: { subsidiaryId: SUBSIDIARY_ID, caseData: { basicInfo: { title: "Test RCE", cveId: "CVE-2024-TEST",
        cvss_score: 9.1, severity: "CRITICAL", vuln_type: "RCE", tags: ["java"] },
        attackPath: { entryPoint: "HTTP", chainSummary: "RCE via JNDI", finalImpact: "full access" },
        remediation: { immediate: "upgrade" } } } });
    expect(r.status).toBe(200);
    expect(r.data.case.status).toBe("pending_review");
    caseId = r.data.case.id;
  });

  it("POST /cases 必填校验", async () => {
    const r = await api("/api/v1/cases", { method: "POST", token: "dev-token", body: {} });
    expect(r.status).toBe(400);
  });

  it("GET /cases 检索", async () => {
    const r = await api("/api/v1/cases", { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.cases.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /cases/:id 详情", async () => {
    const r = await api(`/api/v1/cases/${caseId}`, { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.case.title).toBe("Test RCE");
    expect(r.data.case.cvss_score).toBe("9.1");
  });

  it("PUT /cases/:id/status approve", async () => {
    const r = await api(`/api/v1/cases/${caseId}/status`, { method: "PUT", token: "dev-token", body: { action: "approve", reason: "ok" } });
    expect(r.status).toBe(200);
    expect(r.data.oldStatus).toBe("pending_review");
    expect(r.data.newStatus).toBe("published");
  });

  it("PUT /cases/:id/status reject 已发布 409", async () => {
    const r = await api(`/api/v1/cases/${caseId}/status`, { method: "PUT", token: "dev-token", body: { action: "reject" } });
    expect(r.status).toBe(409);
  });

  it("PUT /cases/:id/status archive", async () => {
    const r = await api(`/api/v1/cases/${caseId}/status`, { method: "PUT", token: "dev-token", body: { action: "archive" } });
    expect(r.status).toBe(200);
    expect(r.data.newStatus).toBe("archived");
  });

  it("POST /cases/:id/feedback", async () => {
    const r = await api(`/api/v1/cases/${caseId}/feedback`, { method: "POST", token: "dev-token",
      body: { subsidiaryId: SUBSIDIARY_ID, fixStatus: "fixed", note: "done" } });
    expect(r.status).toBe(200);
  });
});

// ==================== 告警规则 ====================

describe("v1 /alerts", () => {
  it("POST /alerts/rules 创建", async () => {
    const r = await api("/api/v1/alerts/rules", { method: "POST", token: "dev-token",
      body: { name: "test-cpu", severity: "HIGH", metric: "memory.heapUsedMb",
        condition: { operator: ">", threshold: 500, windowSeconds: 60 },
        channels: ["in_app"], enabled: true } });
    expect(r.status).toBe(200);
    expect(r.data.rule.name).toBe("test-cpu");
    ruleId = r.data.rule.id;
  });

  it("GET /alerts/rules 列表", async () => {
    const r = await api("/api/v1/alerts/rules", { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.rules.length).toBeGreaterThanOrEqual(1);
  });

  it("PUT /alerts/rules/:id 更新", async () => {
    const r = await api(`/api/v1/alerts/rules/${ruleId}`, { method: "PUT", token: "dev-token",
      body: { severity: "CRITICAL", enabled: false } });
    expect(r.status).toBe(200);
    expect(r.data.rule.severity).toBe("CRITICAL");
    expect(r.data.rule.enabled).toBe(false);
  });

  it("GET /alerts/history", async () => {
    const r = await api("/api/v1/alerts/history", { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.alerts)).toBe(true);
  });

  it("GET /alerts/stats", async () => {
    const r = await api("/api/v1/alerts/stats", { token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("total");
    expect(r.data).toHaveProperty("bySeverity");
    expect(r.data).toHaveProperty("byStatus");
  });

  it("DELETE /alerts/rules/:id", async () => {
    const r = await api(`/api/v1/alerts/rules/${ruleId}`, { method: "DELETE", token: "dev-token" });
    expect(r.status).toBe(200);
    expect(r.data.deleted).toBe(true);
  });

  it("DELETE /alerts/rules/:id 重复删除 404", async () => {
    const r = await api(`/api/v1/alerts/rules/${ruleId}`, { method: "DELETE", token: "dev-token" });
    expect(r.status).toBe(404);
  });

  it("POST /alerts/:id/acknowledge 不存在 404", async () => {
    const r = await api("/api/v1/alerts/00000000-0000-0000-0000-000000000000/acknowledge", { method: "POST", token: "dev-token" });
    expect(r.status).toBe(404);
  });
});
