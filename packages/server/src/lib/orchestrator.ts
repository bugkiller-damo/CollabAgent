// ============================================================
// 任务编排器 — 串联 mock 引擎与渗透任务状态机
// 流程：v1 创建任务 → 编排器调度 mock 引擎 → 落库结果 → 触发病例
// ============================================================

import type { FastifyInstance } from "fastify";
import { defaultRegistry, registerMockAdapters } from "@collabagent/adapter-layer";
import type { UUID, PenetrationResultsResponse } from "@collabagent/shared";

let orchestratorStarted = false;

/** 注册 mock 适配器并启动编排器（dev 模式使用 mock，生产环境应注入真实适配器） */
export function startOrchestrator(_app: FastifyInstance): void {
  if (orchestratorStarted) return;
  orchestratorStarted = true;
  registerMockAdapters(defaultRegistry);
  console.log("[Orchestrator] started with mock adapters");
}

/** 派发渗透任务到 mock 引擎 */
export async function dispatchPenetrationTask(
  app: FastifyInstance,
  task: { id: UUID; subsidiaryId: UUID; targets: any[] }
): Promise<void> {
  try {
    // 状态：pending → queued
    await app.pg.query("UPDATE penetration_tasks SET status = 'queued', updated_at = now() WHERE id = $1", [task.id]);

    // 调用 mock 引擎创建任务
    const createResult = await defaultRegistry.execute<{ taskRef: string }>(
      "penetration",
      (instance) => (instance as any).createTask({
        taskType: "full_penetration",
        targets: task.targets.map((t: any) => ({ target: t.target || t.ip, assetLevel: t.assetLevel || "general" })),
        scanProfile: "standard",
      }),
    );

    if (!createResult.success || !createResult.data) {
      await app.pg.query("UPDATE penetration_tasks SET status = 'failed', updated_at = now() WHERE id = $1", [task.id]);
      return;
    }

    const taskRef = createResult.data.taskRef;
    // 状态：queued → running
    await app.pg.query("UPDATE penetration_tasks SET status = 'running', started_at = now(), engine_ref = $1 WHERE id = $2", [taskRef, task.id]);

    // 等待 mock 引擎完成（实际场景应是 webhook 回调或长轮询）
    setTimeout(async () => {
      try {
        const result = await defaultRegistry.execute(
          "penetration",
          (instance) => (instance as any).getResults(taskRef),
        );
        if (!result.success || !result.data) return;
        const r = result.data as any;
        const vulns: NonNullable<PenetrationResultsResponse["vulnerabilities"]> = r.vulnerabilities || [];

        // 1. 落库 penetration_results（拆分 IP 与端口）
        for (const v of vulns) {
          const targetStr = String(v.target || "");
          const [ip, portStr] = targetStr.split(":");
          const port = portStr ? Number(portStr) : null;
          await app.pg.query(
            `INSERT INTO penetration_results (task_id, target, vuln_id, title, cvss_score, severity, vuln_type, attack_path, remediation, discovered_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
            [task.id, ip || "0.0.0.0", v.vulnId, v.title, v.cvssScore, v.severity, v.vulnType,
             JSON.stringify({ ...v.attackPath, port }), JSON.stringify(v.remediation)]
          );
        }

        // 2. 落库 attack_graph
        if (r.attackGraph?.nodes?.length) {
          await app.pg.query(
            `INSERT INTO attack_graphs (task_id, nodes, edges, version) VALUES ($1, $2, $3, 1)`,
            [task.id, JSON.stringify(r.attackGraph.nodes), JSON.stringify(r.attackGraph.edges || [])]
          );
        }

        // 3. 更新任务状态
        const summary = r.summary;
        const findings = {
          critical: summary.critical || 0, high: summary.high || 0,
          medium: summary.medium || 0, low: summary.low || 0, info: 0,
        };
        await app.pg.query(
          `UPDATE penetration_tasks
           SET status = 'completed', completed_at = now(), progress_percent = 100,
               completed_targets = $2, total_targets = $3, findings_summary = $4::jsonb, updated_at = now()
           WHERE id = $1`,
          [task.id, summary.targetsScanned || 0, summary.targetsScanned || 0, JSON.stringify(findings)]
        );

        // 4. 高危漏洞自动建病例草稿（cases 表字段已拆分为 entry_point/chain_summary/final_impact）
        const criticals = vulns.filter((v) => v.severity === "CRITICAL" || v.severity === "HIGH");
        for (const v of criticals) {
          const ap = v.attackPath || {};
          await app.pg.query(
            `INSERT INTO cases (subsidiary_id, status, title, cve_id, cvss_score, severity, vuln_type, entry_point, chain_summary, final_impact, remediation_immediate, affected_fingerprints)
             VALUES ($1, 'pending_review', $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]')`,
            [task.subsidiaryId, `[自动] ${v.title}`, v.cveId || null, v.cvssScore, v.severity, v.vulnType,
             String(ap.entryPoint || v.target || ""),
             typeof ap === "object" && "chain" in ap ? JSON.stringify(ap.chain) : String(ap.summary || ""),
             String(ap.finalImpact || "需分析"),
             v.remediation?.immediate || "见安全建议"]
          );
        }

        console.log(`[Orchestrator] task ${task.id} completed: ${vulns.length} vulns, ${criticals.length} cases auto-created`);
      } catch (err: any) {
        console.error(`[Orchestrator] task ${task.id} processing error:`, err?.message);
        await app.pg.query("UPDATE penetration_tasks SET status = 'failed', updated_at = now() WHERE id = $1", [task.id]);
      }
    }, 3000);
  } catch (err: any) {
    console.error(`[Orchestrator] dispatch error for task ${task.id}:`, err?.message);
  }
}
