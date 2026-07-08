import type { FastifyInstance } from "fastify";

export async function caseRoutes(app: FastifyInstance) {
  // ---- 病例上报 ----
  app.post("/", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { subsidiaryId, caseData } = req.body as any;
    if (!subsidiaryId || !caseData?.basicInfo) return reply.status(400).send({ error: "subsidiaryId and caseData.basicInfo required" });
    const info = caseData.basicInfo;
    if (!info.title || info.cvss_score === undefined || !info.severity || !info.vuln_type) {
      return reply.status(400).send({ error: "title, cvss_score, severity, vuln_type required" });
    }
    const result = await app.pg.query(
      `INSERT INTO cases (subsidiary_id, status, title, cve_id, cvss_score, severity, vuln_type,
        affected_component, tags, entry_point, chain_summary, final_impact, poc_summary,
        verification_ref, remediation_immediate, remediation_workaround, remediation_long_term, affected_fingerprints)
       VALUES ($1, 'pending_review', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id, status, version, created_at`,
      [subsidiaryId, info.title, info.cveId || null, info.cvss_score, info.severity, info.vuln_type,
       info.affectedComponent ? JSON.stringify(info.affectedComponent) : null, info.tags || [],
       caseData.attackPath?.entryPoint || null, caseData.attackPath?.chainSummary || null, caseData.attackPath?.finalImpact || null,
       caseData.exploitEvidence?.pocSummary || null, caseData.exploitEvidence?.verificationRef || null,
       caseData.remediation?.immediate || null, caseData.remediation?.workaround || null, caseData.remediation?.longTerm || null,
       caseData.affectedAssets ? JSON.stringify(caseData.affectedAssets) : '[]']
    );
    return { case: result.rows[0] };
  });

  // ---- 病历检索 ----
  app.get("/", { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { q, severity, vulnType, cveId, tag, subsidiaryId, status, page, pageSize, sortBy, order, createdAfter, createdBefore } = req.query as Record<string, string>;
    const conditions: string[] = []; const params: any[] = []; let p = 1;
    if (q) { conditions.push(`(c.title ILIKE $${p} OR c.cve_id ILIKE $${p})`); params.push(`%${q}%`); p++; }
    if (severity) { conditions.push(`c.severity = ANY($${p++})`); params.push(severity.split(",")); }
    if (vulnType) { conditions.push(`c.vuln_type = ANY($${p++})`); params.push(vulnType.split(",")); }
    if (cveId) { conditions.push(`c.cve_id = $${p++}`); params.push(cveId); }
    if (tag) { conditions.push(`c.tags && $${p++}`); params.push(tag.split(",")); }
    if (subsidiaryId) { conditions.push(`c.subsidiary_id = $${p++}`); params.push(subsidiaryId); }
    if (status) { conditions.push(`c.status = ANY($${p++})`); params.push(status.split(",")); }
    if (createdAfter) { conditions.push(`c.created_at >= $${p++}`); params.push(createdAfter); }
    if (createdBefore) { conditions.push(`c.created_at <= $${p++}`); params.push(createdBefore); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = ((parseInt(page) || 1) - 1) * limit;
    const sortField = sortBy === "cvss_score" ? "c.cvss_score" : sortBy === "share_count" ? "(c.distribution_status->>'totalPushed')::int" : "c.created_at";
    const sortDir = order === "asc" ? "ASC" : "DESC";
    const count = Number((await app.pg.query(`SELECT count(*)::int as c FROM cases c ${where}`, params)).rows[0]?.c ?? 0);
    const rows = await app.pg.query(
      `SELECT c.id, c.title, c.cve_id, c.cvss_score, c.severity, c.vuln_type, c.tags, c.status,
              c.subsidiary_id, c.distribution_status, c.remediation_immediate as remediation_summary,
              c.version, c.created_at, c.updated_at
       FROM cases c ${where} ORDER BY ${sortField} ${sortDir} LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset]
    );
    return { cases: rows.rows, pagination: { page: parseInt(page) || 1, pageSize: limit, totalCount: count, totalPages: Math.ceil(count / limit) } };
  });

  // ---- 详情 ----
  app.get("/:caseId", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const r = await app.pg.query("SELECT * FROM cases WHERE id = $1", [req.params.caseId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "case not found" });
    return { case: r.rows[0] };
  });

  // ---- 状态更新 ----
  app.put("/:caseId/status", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { action, reason, reviewerId } = req.body as Record<string, string>;
    const valid = ["approve", "reject", "archive", "revise", "mark_fixed"];
    if (!valid.includes(action)) return reply.status(400).send({ error: `action must be: ${valid.join(", ")}` });
    const r = await app.pg.query("SELECT id, status FROM cases WHERE id = $1", [req.params.caseId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "case not found" });
    const current = String(r.rows[0].status ?? "");
    const tx: Record<string, Record<string, string>> = {
      approve: { pending_review: "published" }, reject: { pending_review: "rejected" },
      archive: { published: "archived" }, revise: { published: "pending_review" },
      mark_fixed: { published: "published" },
    };
    const ns = (tx[action] || {})[current];
    if (ns === undefined) return reply.status(409).send({ error: `cannot ${action} case in ${current} status` });

    if (action === "mark_fixed") {
      const c = r.rows[0] as any;
      const ds = typeof c.distribution_status === "string" ? JSON.parse(c.distribution_status) : c.distribution_status || {};
      ds.confirmedFixed = (ds.confirmedFixed || 0) + 1;
      await app.pg.query("UPDATE cases SET distribution_status = $1::jsonb, version = version + 1, updated_at = now() WHERE id = $2",
        [JSON.stringify(ds), req.params.caseId]);
    } else {
      await app.pg.query(
        `UPDATE cases SET status = $1, version = version + 1, reviewer_id = $2, review_comment = $3,
         ${ns === "published" ? "published_at = now()," : ""} updated_at = now() WHERE id = $4`,
        [ns, reviewerId || null, reason || null, req.params.caseId]
      );
    }
    return { caseId: req.params.caseId, action, oldStatus: current, newStatus: ns };
  });

  // ---- 修复反馈 ----
  app.post("/:caseId/feedback", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { subsidiaryId, fixStatus, note } = req.body as any;
    if (!subsidiaryId || !fixStatus) return reply.status(400).send({ error: "subsidiaryId and fixStatus required" });
    const valid = ["fixed", "partial", "not_applicable", "fix_failed"];
    if (!valid.includes(fixStatus)) return reply.status(400).send({ error: `fixStatus must be: ${valid.join(", ")}` });
    const r = await app.pg.query("SELECT distribution_status FROM cases WHERE id = $1", [req.params.caseId]);
    if (r.rows.length === 0) return reply.status(404).send({ error: "case not found" });
    const ds = typeof r.rows[0].distribution_status === "string" ? JSON.parse(r.rows[0].distribution_status) : r.rows[0].distribution_status || {};
    if (fixStatus === "fixed") ds.confirmedFixed = (ds.confirmedFixed || 0) + 1;
    else if (fixStatus === "not_applicable") ds.notApplicable = (ds.notApplicable || 0) + 1;
    else if (fixStatus === "fix_failed") ds.pending = (ds.pending || 0) + 1;
    await app.pg.query("UPDATE cases SET distribution_status = $1::jsonb, version = version + 1, updated_at = now() WHERE id = $2",
      [JSON.stringify(ds), req.params.caseId]);
    return { caseId: req.params.caseId, subsidiaryId, fixStatus, note: note || null };
  });

  // ---- 分发通知 ----
  app.get("/notifications", { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { subsidiaryId, page, pageSize } = req.query as Record<string, string>;
    if (!subsidiaryId) return { notifications: [] };
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = ((parseInt(page) || 1) - 1) * limit;
    const rows = await app.pg.query(
      `SELECT c.id, c.title, c.cve_id, c.cvss_score, c.severity, c.vuln_type, c.tags,
              c.affected_fingerprints, c.created_at, c.remediation_immediate
       FROM cases c WHERE c.status = 'published' AND c.created_at > now() - interval '30 days'
       ORDER BY c.cvss_score DESC, c.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const count = Number((await app.pg.query("SELECT count(*)::int as c FROM cases WHERE status = 'published' AND created_at > now() - interval '30 days'")).rows[0]?.c ?? 0);
    return { notifications: rows.rows, pagination: { page: parseInt(page) || 1, pageSize: limit, totalCount: count, totalPages: Math.ceil(count / limit) } };
  });
}
