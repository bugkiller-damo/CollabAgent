import type { FastifyInstance } from "fastify";

export async function assetRoutes(app: FastifyInstance) {
  // 获取资产列表
  app.get("/", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { subsidiaryId, assetLevel, status, tags, page, pageSize, q } = req.query as Record<string, string>;
    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (subsidiaryId) { conditions.push(`a.subsidiary_id = $${p++}`); params.push(subsidiaryId); }
    if (assetLevel) { conditions.push(`a.asset_level = $${p++}`); params.push(assetLevel); }
    if (status) { conditions.push(`a.status = $${p++}`); params.push(status); }
    if (q) { conditions.push(`(a.hostname ILIKE $${p} OR a.ip::text ILIKE $${p} OR a.domain ILIKE $${p})`); params.push(`%${q}%`); p++; }
    if (tags) { conditions.push(`a.tags && $${p++}`); params.push(tags.split(",")); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = ((parseInt(page) || 1) - 1) * limit;

    const countResult = await app.pg.query(`SELECT count(*)::int as total FROM assets a ${where}`, params);
    const result = await app.pg.query(
      `SELECT a.* FROM assets a ${where} ORDER BY a.created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset]
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    return { assets: result.rows, pagination: { page: parseInt(page) || 1, pageSize: limit, totalCount: total, totalPages: Math.ceil(total / limit) } };
  });

  // 获取单个资产
  app.get("/:assetId", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { assetId } = req.params as Record<string, string>;
    const result = await app.pg.query("SELECT * FROM assets WHERE id = $1", [assetId]);
    if (result.rows.length === 0) return reply.status(404).send({ error: "asset not found" });
    return { asset: result.rows[0] };
  });

  // 创建/upsert 资产
  app.post("/", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { subsidiaryId, ip, hostname, domain, os, openPorts, services, assetLevel, tags } = req.body as any;
    if (!subsidiaryId || !ip) return reply.status(400).send({ error: "subsidiaryId and ip required" });
    const result = await app.pg.query(
      `INSERT INTO assets (subsidiary_id, ip, hostname, domain, os, open_ports, services, asset_level, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (subsidiary_id, ip) DO UPDATE SET
         hostname = COALESCE($3, assets.hostname), os = COALESCE($5, assets.os),
         open_ports = $6, services = $7, asset_level = COALESCE($8, assets.asset_level),
         tags = COALESCE($9, assets.tags), status = 'active', last_seen_at = now(), updated_at = now()
       RETURNING *`,
      [subsidiaryId, ip, hostname || null, domain || null, os || null, openPorts || [], JSON.stringify(services || []), assetLevel || "general", tags || []]
    );
    return { asset: result.rows[0] };
  });

  // 更新资产
  app.patch("/:assetId", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { assetId } = req.params as Record<string, string>;
    const fields = req.body as Record<string, any>;
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const key of ["hostname", "domain", "os", "open_ports", "services", "fingerprints", "asset_level", "tags", "status"]) {
      if (fields[key] !== undefined) {
        if (key === "services" || key === "fingerprints") { sets.push(`${key} = $${p++}::jsonb`); params.push(JSON.stringify(fields[key])); }
        else if (key === "tags" || key === "open_ports") { sets.push(`${key} = $${p++}`); params.push(fields[key]); }
        else { sets.push(`${key} = $${p++}`); params.push(fields[key]); }
      }
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields to update" });
    sets.push("updated_at = now()");
    params.push(assetId);
    const result = await app.pg.query(`UPDATE assets SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`, params);
    if (result.rows.length === 0) return reply.status(404).send({ error: "asset not found" });
    return { asset: result.rows[0] };
  });

  // 批量导入
  app.post("/import", { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { subsidiaryId, assets } = req.body as any;
    if (!subsidiaryId || !Array.isArray(assets) || assets.length === 0) return reply.status(400).send({ error: "subsidiaryId and assets[] required" });
    if (assets.length > 1000) return reply.status(400).send({ error: "max 1000 assets per batch" });
    let imported = 0;
    for (const a of assets) {
      try {
        await app.pg.query(
          `INSERT INTO assets (subsidiary_id, ip, hostname, domain, os, open_ports, services, asset_level, tags, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
           ON CONFLICT (subsidiary_id, ip) DO UPDATE SET hostname = COALESCE($3, assets.hostname), last_seen_at = now(), updated_at = now()`,
          [subsidiaryId, a.ip, a.hostname || null, a.domain || null, a.os || null, a.openPorts || [], JSON.stringify(a.services || []), a.assetLevel || "general", a.tags || []]
        );
        imported++;
      } catch { /* skip */ }
    }
    return { imported, total: assets.length };
  });
}
