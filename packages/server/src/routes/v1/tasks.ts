import type { FastifyInstance } from "fastify";
import { resolveUserContext } from "../../lib/orgs.js";
import { dispatchPenetrationTask } from "../../lib/orchestrator.js";

export async function taskRoutes(app: FastifyInstance) {
  // ---- 创建任务 ----
  app.post("/", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { idempotencyKey, taskType, taskName, targets, scanProfile, maxConcurrency, timeout, priority, allowedOperations, restrictedOperations, callbackUrl } = req.body as any;
    if (!taskType || !taskName || !targets?.length) return reply.status(400).send({ error: "taskType, taskName, and targets[] required" });
    if (targets.length > 500) return reply.status(400).send({ error: "max 500 targets per task" });

    if (idempotencyKey) {
      const existing = await app.pg.query("SELECT id, status FROM penetration_tasks WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) return { task: existing.rows[0], duplicated: true };
    }

    const { userId, subsidiaryId } = await resolveUserContext(app, req.user.sub, req.user.handle);
    const result = await app.pg.query(
      `INSERT INTO penetration_tasks (subsidiary_id, task_type, task_name, status, priority, scan_profile, targets, max_concurrency, timeout_seconds, allowed_operations, restricted_operations, callback_url, idempotency_key, created_by, total_targets)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [subsidiaryId, taskType, taskName, priority || "MEDIUM", scanProfile || "standard",
       JSON.stringify(targets), maxConcurrency || 10, timeout || 3600, allowedOperations || [], restrictedOperations || [],
       callbackUrl || null, idempotencyKey || null, userId, targets.length]
    );

    // 触发编排器（仅渗透类任务，quick_scan/vuln_scan/full_penetration）
    if (["full_penetration", "vulnerability_scan", "quick_scan"].includes(taskType)) {
      void dispatchPenetrationTask(app, { id: String(result.rows[0].id), subsidiaryId, targets });
    }

    return { task: result.rows[0] };
  });

  // ---- 任务列表 ----
  app.get("/", { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { status, priority, taskType, page, pageSize, createdAfter, createdBefore, sort, order } = req.query as Record<string, string>;
    const conditions: string[] = []; const params: any[] = []; let p = 1;
    if (status) { conditions.push(`status = ANY($${p++})`); params.push(status.split(",")); }
    if (priority) { conditions.push(`priority = ANY($${p++})`); params.push(priority.split(",")); }
    if (taskType) { conditions.push(`task_type = ANY($${p++})`); params.push(taskType.split(",")); }
    if (createdAfter) { conditions.push(`created_at >= $${p++}`); params.push(createdAfter); }
    if (createdBefore) { conditions.push(`created_at <= $${p++}`); params.push(createdBefore); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = ((parseInt(page) || 1) - 1) * limit;
    const sortField = sort === "priority" ? "priority" : "created_at";
    const sortDir = order === "asc" ? "ASC" : "DESC";

    const count = Number((await app.pg.query(`SELECT count(*)::int as c FROM penetration_tasks ${where}`, params)).rows[0]?.c ?? 0);
    const rows = await app.pg.query(
      `SELECT id, task_type, task_name, status, priority, progress_percent, total_targets, completed_targets, findings_summary, created_at, updated_at, started_at, completed_at
       FROM penetration_tasks ${where} ORDER BY ${sortField} ${sortDir} LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset]
    );
    return { tasks: rows.rows, pagination: { page: parseInt(page) || 1, pageSize: limit, totalCount: count, totalPages: Math.ceil(count / limit) } };
  });

  // ---- 详情 ----
  app.get("/:taskId", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const r = await app.pg.query("SELECT * FROM penetration_tasks WHERE id = $1", [req.params.taskId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "task not found" });
    return { task: r.rows[0] };
  });

  // ---- 状态 ----
  app.get("/:taskId/status", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const r = await app.pg.query(
      `SELECT id, status, progress_percent, total_targets, completed_targets, findings_summary, updated_at as last_activity
       FROM penetration_tasks WHERE id = $1`, [req.params.taskId]
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "task not found" });
    const t = r.rows[0] as any;
    const f = typeof t.findings_summary === "string" ? JSON.parse(t.findings_summary) : t.findings_summary || {};
    return { taskId: t.id, status: t.status, progress: { percent: t.progress_percent, targetsCompleted: t.completed_targets, targetsTotal: t.total_targets }, findings: { critical: f.critical || 0, high: f.high || 0, medium: f.medium || 0, low: f.low || 0 }, lastActivity: t.last_activity };
  });

  // ---- 控制 ----
  app.post("/:taskId/control", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { action } = req.body as Record<string, string>;
    const valid = ["pause", "resume", "stop", "terminate"];
    if (!valid.includes(action)) return reply.status(400).send({ error: `action must be: ${valid.join(", ")}` });
    const r = await app.pg.query("SELECT id, status FROM penetration_tasks WHERE id = $1", [req.params.taskId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "task not found" });
    const current = String(r.rows[0].status ?? "");
    const allowed: Record<string, string[]> = { pause: ["running", "queued"], resume: ["paused"], stop: ["running", "paused", "queued"], terminate: ["running", "paused", "queued"] };
    if (!(allowed[action] || []).includes(current)) return reply.status(409).send({ error: `cannot ${action} task in ${current} status` });
    const next = action === "resume" ? "running" : action === "pause" ? "paused" : "terminated";
    await app.pg.query(`UPDATE penetration_tasks SET status = $1, updated_at = now()${next === "terminated" ? ", completed_at = now()" : ""} WHERE id = $2`, [next, req.params.taskId]);
    return { taskId: req.params.taskId, action, oldStatus: current, newStatus: next };
  });

  // ---- 结果 ----
  app.get("/:taskId/results", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const r = await app.pg.query("SELECT id, status, findings_summary FROM penetration_tasks WHERE id = $1", [req.params.taskId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "task not found" });
    const t = r.rows[0] as any;
    const f = typeof t.findings_summary === "string" ? JSON.parse(t.findings_summary) : t.findings_summary || {};
    const limit = Math.min(parseInt(req.query.pageSize) || 50, 200);
    const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    const vulns = await app.pg.query(`SELECT id, target, hostname, vuln_id, title, cvss_score, severity, vuln_type, attack_path, exploit_evidence, remediation, discovered_at FROM penetration_results WHERE task_id = $1 ORDER BY cvss_score DESC NULLS LAST LIMIT $2 OFFSET $3`, [req.params.taskId, limit, offset]);
    const total = Number((await app.pg.query("SELECT count(*)::int as c FROM penetration_results WHERE task_id = $1", [req.params.taskId])).rows[0]?.c ?? 0);
    return { taskId: req.params.taskId, status: t.status, summary: { totalVulnerabilities: total, critical: f.critical || 0, high: f.high || 0, medium: f.medium || 0, low: f.low || 0 }, vulnerabilities: vulns.rows, pagination: { page: parseInt(req.query.page) || 1, pageSize: limit, totalCount: total, totalPages: Math.ceil(total / limit) } };
  });

  // ---- 攻击图 ----
  app.get("/:taskId/attack-graph", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { since } = req.query as Record<string, string>;
    const q = since
      ? await app.pg.query("SELECT nodes, edges, version, created_at FROM attack_graphs WHERE task_id = $1 AND created_at > $2 ORDER BY version DESC LIMIT 1", [req.params.taskId, since])
      : await app.pg.query("SELECT nodes, edges, version, created_at FROM attack_graphs WHERE task_id = $1 ORDER BY version DESC LIMIT 1", [req.params.taskId]);
    if (q.rows.length === 0) return reply.status(404).send({ error: "no attack graph for this task" });
    const g = q.rows[0] as any;
    return { taskId: req.params.taskId, incremental: !!since, nodes: g.nodes, edges: g.edges, generatedAt: g.created_at };
  });

  // ---- 日志 ----
  app.get("/:taskId/logs", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const r = await app.pg.query("SELECT id, status, created_at, updated_at, started_at, completed_at FROM penetration_tasks WHERE id = $1", [req.params.taskId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "task not found" });
    const t = r.rows[0] as any;
    const logs: any[] = [];
    if (t.created_at) logs.push({ timestamp: t.created_at, role: "system", content: `[任务] 创建，状态: pending` });
    if (t.started_at) logs.push({ timestamp: t.started_at, role: "system", content: `[任务] 开始执行` });
    if (t.completed_at) logs.push({ timestamp: t.completed_at, role: "system", content: `[任务] 完成，状态: ${t.status}` });
    const vulns = await app.pg.query("SELECT title, severity, target, discovered_at FROM penetration_results WHERE task_id = $1 ORDER BY discovered_at ASC LIMIT 50", [req.params.taskId]);
    for (const v of vulns.rows as any) logs.push({ timestamp: v.discovered_at, role: "agent", content: `[发现] ${v.severity} ${v.title} (${v.target})` });
    return { taskId: req.params.taskId, logs };
  });

  // ---- 发消息 ----
  app.post("/:taskId/msg", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { content, targetAgent } = req.body as any;
    if (!content) return reply.status(400).send({ error: "content required" });
    const r = await app.pg.query("SELECT id FROM penetration_tasks WHERE id = $1", [req.params.taskId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "task not found" });
    return { taskId: req.params.taskId, messageId: `msg-${Date.now().toString(36)}`, status: "delivered", deliveredTo: targetAgent || "coordinator", timestamp: new Date().toISOString() };
  });

  // ---- 批量 ----
  app.post("/batch", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { userId: batchUserId, subsidiaryId: batchSubsidiaryId } = await resolveUserContext(app, req.user.sub, req.user.handle);
    const { operations } = req.body as any;
    if (!Array.isArray(operations) || operations.length > 50) return reply.status(400).send({ error: "operations[] required, max 50" });
    const results: any[] = [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      try {
        if (op.action === "create") {
          const t = op.task;
          const r = await app.pg.query(`INSERT INTO penetration_tasks (subsidiary_id, task_type, task_name, status, priority, targets, created_by, total_targets) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7) RETURNING id`,
            [batchSubsidiaryId, t.taskType, t.taskName, t.priority || "MEDIUM", JSON.stringify(t.targets), batchUserId, t.targets?.length || 0]);
          results.push({ index: i, status: "accepted", taskId: r.rows[0].id });
        } else if (op.action === "control" && op.taskId) {
          await app.pg.query("UPDATE penetration_tasks SET status = $1, updated_at = now() WHERE id = $2", [op.control === "pause" ? "paused" : "terminated", op.taskId]);
          results.push({ index: i, status: "accepted", taskId: op.taskId });
        } else results.push({ index: i, status: "failed", error: "invalid operation" });
      } catch (err: any) { results.push({ index: i, status: "failed", error: err.message }); }
    }
    return { results, failedCount: results.filter((r) => r.status === "failed").length };
  });
}
