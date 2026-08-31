import { randomBytes } from "node:crypto";
import type { RuntimeProbe } from "@collabagent/shared";
import type { FastifyInstance } from "fastify";
import { MACHINE_TOKEN_TTL_DAYS } from "../lib/machine-token-policy.js";
import { getOrCreatePersonalOrg, getUserOrgIds } from "../lib/orgs.js";
import { normalizeRuntimes } from "../lib/runtime-probe.js";
import { sha256Token } from "../lib/token-hash.js";
import { daemonClients, daemonMeta } from "../ws/handler.js";

export interface ComputerRow {
  id: string;
  user_id: string;
  server_id: string;
  name: string;
  description: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemon_version: string | null;
  runtimes: unknown;
  last_ready_at: Date | string | null;
  created_at: Date | string;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function defaultName(hostname?: string | null): string {
  const h = (hostname || "").trim();
  return h || "我的计算机";
}

export async function loadComputerRow(app: FastifyInstance, userId: string): Promise<ComputerRow | null> {
  const r = await app.pg.query<ComputerRow>("SELECT * FROM computers WHERE user_id::text = $1", [userId]);
  return r.rows[0] || null;
}

export async function ensureComputerRow(
  app: FastifyInstance,
  userId: string,
  handle?: string,
  seed?: { hostname?: string | null },
): Promise<ComputerRow> {
  const existing = await loadComputerRow(app, userId);
  if (existing) return existing;
  const orgIds = await getUserOrgIds(app, userId);
  const serverId = orgIds[0] || (await getOrCreatePersonalOrg(app, userId, handle));
  const inserted = await app.pg.query<ComputerRow>(
    `INSERT INTO computers (user_id, server_id, name, description, hostname)
     VALUES ($1, $2, $3, '', $4)
     ON CONFLICT (user_id) DO UPDATE SET user_id = computers.user_id
     RETURNING *`,
    [userId, serverId, defaultName(seed?.hostname), seed?.hostname || null],
  );
  return inserted.rows[0]!;
}

export function serializeComputer(
  row: ComputerRow,
  extras: { online: boolean; runtimes: RuntimeProbe[]; connectedAt: number | null },
) {
  return {
    id: row.id,
    userId: row.user_id,
    serverId: row.server_id,
    name: row.name,
    description: row.description || "",
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    daemonVersion: row.daemon_version,
    lastReadyAt: iso(row.last_ready_at),
    createdAt: iso(row.created_at),
    online: extras.online,
    runtimes: extras.runtimes,
    connectedAt: extras.connectedAt,
  };
}

export function computerStatusPayload(_app: FastifyInstance, userId: string, row: ComputerRow | null) {
  const meta = daemonMeta.get(userId);
  const online = daemonClients.has(userId);
  const runtimes = meta?.runtimes?.length ? meta.runtimes : normalizeRuntimes(row?.runtimes);
  return {
    connected: online,
    hostname: meta?.hostname ?? row?.hostname ?? null,
    os: meta?.os ?? row?.os ?? null,
    arch: meta?.arch ?? row?.arch ?? null,
    daemonVersion: meta?.daemonVersion ?? row?.daemon_version ?? null,
    runtimes,
    connectedAt: meta?.connectedAt ?? null,
    computer: row ? serializeComputer(row, { online, runtimes, connectedAt: meta?.connectedAt ?? null }) : null,
  };
}

function mintMachineTokenValue(): string {
  return "sk_machine_" + randomBytes(16).toString("hex").slice(0, 32);
}

export function connectCommand(serverUrl: string, token: string): string {
  const origin = serverUrl.replace(/\/+$/, "");
  return `pnpm --filter @collabagent/daemon dev -- --server-url ${origin} --api-key ${token}`;
}

export async function computerRoutes(app: FastifyInstance) {
  // GET /api/computers/me — 没有行则 404（空对象由 POST 幂等创建）
  app.get("/me", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const userId = String(req.user.sub);
    const row = await loadComputerRow(app, userId);
    if (!row) return reply.status(404).send({ error: "computer not found" });
    return computerStatusPayload(app, userId, row);
  });

  // POST /api/computers — 确保我有一行（幂等）
  app.post("/", { preHandler: [app.authenticate] }, async (req: any) => {
    const userId = String(req.user.sub);
    const meta = daemonMeta.get(userId);
    const row = await ensureComputerRow(app, userId, req.user.handle, { hostname: meta?.hostname });
    return computerStatusPayload(app, userId, row);
  });

  // GET /api/computers/:id — 仅自己的；别人 403
  app.get("/:id", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const userId = String(req.user.sub);
    const { id } = req.params as { id: string };
    const r = await app.pg.query<ComputerRow>("SELECT * FROM computers WHERE id = $1", [id]);
    const row = r.rows[0];
    if (!row) return reply.status(404).send({ error: "computer not found" });
    if (String(row.user_id) !== userId) return reply.status(403).send({ error: "forbidden" });
    return computerStatusPayload(app, userId, row);
  });

  // PATCH /api/computers/me
  app.patch("/me", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const userId = String(req.user.sub);
    const body = (req.body || {}) as { name?: unknown; description?: unknown };
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return reply.status(400).send({ error: "name required" });
      sets.push(`name = $${p++}`);
      params.push(name);
    }
    if (typeof body.description === "string") {
      sets.push(`description = $${p++}`);
      params.push(body.description);
    }
    if (sets.length === 0) return reply.status(400).send({ error: "no fields to update" });
    params.push(userId);
    const r = await app.pg.query<ComputerRow>(
      `UPDATE computers SET ${sets.join(", ")} WHERE user_id::text = $${p} RETURNING *`,
      params,
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "computer not found" });
    return computerStatusPayload(app, userId, r.rows[0]!);
  });

  // DELETE /api/computers/me — 还有 agent 则 409
  app.delete("/me", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const userId = String(req.user.sub);
    const row = await loadComputerRow(app, userId);
    if (!row) return reply.status(404).send({ error: "computer not found" });
    const agents = await app.pg.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM agents WHERE user_id::text = $1",
      [userId],
    );
    const count = Number(agents.rows[0]?.c || 0);
    if (count > 0) {
      return reply.status(409).send({ error: "delete agents first", agentCount: count });
    }
    await app.pg.query("DELETE FROM computers WHERE user_id::text = $1", [userId]);
    return { ok: true };
  });

  // POST /api/computers/me/token — 吊销该用户全部 active 钥再签发
  app.post("/me/token", { preHandler: [app.authenticate] }, async (req: any) => {
    const userId = String(req.user.sub);
    const handle = req.user.handle as string | undefined;
    const row = await ensureComputerRow(app, userId, handle, { hostname: daemonMeta.get(userId)?.hostname });

    const orgIds = await getUserOrgIds(app, userId);
    const serverId = orgIds.includes(String(row.server_id))
      ? String(row.server_id)
      : orgIds[0] || (await getOrCreatePersonalOrg(app, userId, handle));

    await app.pg.query("UPDATE machine_tokens SET revoked_at = now() WHERE user_id::text = $1 AND revoked_at IS NULL", [
      userId,
    ]);

    const tokenValue = mintMachineTokenValue();
    // P1.12：轮换签发同样带 90 天默认有效期（滚动续期见 lib/machine-token-policy.ts）。
    // 该端点先吊销全部旧钥再签发（rotation 自限），无需再做数量上限检查。
    const expiresAt = new Date(Date.now() + MACHINE_TOKEN_TTL_DAYS * 86_400_000);
    await app.pg.query(
      "INSERT INTO machine_tokens (user_id, server_id, token_hash, token_prefix, scope, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        userId,
        serverId,
        sha256Token(tokenValue),
        "sk_machine_",
        JSON.stringify({ send: true, read: true, tasks: true }),
        expiresAt,
      ],
    );

    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http");
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001");
    const origin = `${proto}://${host}`;
    return {
      token: tokenValue,
      command: connectCommand(origin, tokenValue),
      message: "Save this token — it won't be shown again. Existing daemon will disconnect.",
    };
  });
}
