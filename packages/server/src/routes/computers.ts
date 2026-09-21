import { randomBytes } from "node:crypto";
import type { RuntimeEntrypointProbe, RuntimeProbe } from "@collabagent/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { computerOnlineFor } from "../lib/agent-duty.js";
import { bridgeRuntimesEnabled, config } from "../lib/config.js";
import {
  countActiveMachineTokens,
  MACHINE_TOKEN_MAX_ACTIVE_PER_USER,
  MACHINE_TOKEN_TTL_DAYS,
} from "../lib/machine-token-policy.js";
import { isOrgOwner } from "../lib/orgs.js";
import { isMachineOnline } from "../lib/presence.js";
import { normalizeEntrypoints, normalizeRuntimes } from "../lib/runtime-probe.js";
import { isServerMember, TENANT_HEADER, UUID_RE } from "../lib/tenant.js";
import { sha256Token } from "../lib/token-hash.js";
import { daemonMeta, findDaemonMeta } from "../ws/handler.js";

export interface ComputerRow {
  id: string;
  user_id: string;
  server_id: string;
  /** daemon 上报的本机稳定身份（.slock/machine-id）；存量行为 legacy-<id> 占位 */
  machine_uuid: string;
  name: string;
  description: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemon_version: string | null;
  runtimes: unknown;
  /** Phase 4：bridge runtime entrypoint 探测摘要快照（032 列，旧行可能缺列由 ?? [] 兜） */
  entrypoints?: unknown;
  last_ready_at: Date | string | null;
  created_at: Date | string;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * /api/daemon/status 兼容读：取该用户最近活跃的一行计算机（跨 server）。
 * server-scoped 端点不走这里——它们按 (serverId) 精确圈定。
 */
export async function loadComputerRow(app: FastifyInstance, userId: string): Promise<ComputerRow | null> {
  const r = await app.pg.query<ComputerRow>(
    "SELECT * FROM computers WHERE user_id::text = $1 ORDER BY last_ready_at DESC NULLS LAST, created_at DESC LIMIT 1",
    [userId],
  );
  return r.rows[0] || null;
}

export function serializeComputer(
  row: ComputerRow,
  extras: {
    online: boolean;
    runtimes: RuntimeProbe[];
    /** Phase 4：entrypoint 探测摘要（live meta 优先、行快照兜底，同 runtimes 口径） */
    entrypoints?: RuntimeEntrypointProbe[];
    connectedAt: number | null;
    ownerHandle?: string | null;
    ownerName?: string | null;
    mine?: boolean;
  },
) {
  return {
    id: row.id,
    userId: row.user_id,
    serverId: row.server_id,
    machineUuid: row.machine_uuid,
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
    entrypoints: extras.entrypoints ?? [],
    connectedAt: extras.connectedAt,
    ownerHandle: extras.ownerHandle ?? null,
    ownerName: extras.ownerName ?? null,
    mine: extras.mine ?? false,
  };
}

/** 行对应的连接 meta——仅当该机器的连接 scope 与本行 server 一致时才归属本行 */
function metaForRow(row: ComputerRow) {
  const meta = daemonMeta.get(`${row.user_id}:${row.machine_uuid}`);
  if (!meta) return null;
  if (meta.serverId && String(row.server_id) !== meta.serverId) return null;
  return meta;
}

function serializeRow(row: ComputerRow, viewerId: string, owner?: { handle: string | null; name: string | null }) {
  const meta = metaForRow(row);
  const online = isMachineOnline(String(row.user_id), row.machine_uuid, String(row.server_id));
  const runtimes = meta?.runtimes?.length ? meta.runtimes : normalizeRuntimes(row.runtimes);
  // meta.entrypoints 为 undefined 时（daemon 未开 flag / 旧 daemon）回落行快照；
  // 空数组是「开了 flag 但没条目」的真值，不回落。
  const entrypoints = meta?.entrypoints ?? normalizeEntrypoints(row.entrypoints);
  return serializeComputer(row, {
    online,
    runtimes,
    entrypoints,
    connectedAt: meta?.connectedAt ?? null,
    ownerHandle: owner?.handle ?? null,
    ownerName: owner?.name ?? null,
    mine: String(row.user_id) === viewerId,
  });
}

export function computerStatusPayload(_app: FastifyInstance, userId: string, row: ComputerRow | null) {
  // meta/在线判定按 (user, server, machine) 三维解析：有行 → 该行的 machineKey；
  // 无行 → 该用户任一连接（空态页仍展示「有 daemon 在别处 scope 运行」的提示位）
  const meta = findDaemonMeta(row ? `${row.user_id}:${row.machine_uuid}` : userId);
  // P1.27：在线判定走跨实例注册表（daemon 连在其他实例时本实例也能看见）；
  // meta 明细（hostname/runtimes/connectedAt）仍是本实例视角，跨实例时回退 computers 行。
  const online = row
    ? isMachineOnline(String(row.user_id), row.machine_uuid, String(row.server_id))
    : computerOnlineFor(userId);
  const runtimes = meta?.runtimes?.length ? meta.runtimes : normalizeRuntimes(row?.runtimes);
  return {
    connected: online,
    hostname: meta?.hostname ?? row?.hostname ?? null,
    os: meta?.os ?? row?.os ?? null,
    arch: meta?.arch ?? row?.arch ?? null,
    daemonVersion: meta?.daemonVersion ?? row?.daemon_version ?? null,
    runtimes,
    entrypoints: meta?.entrypoints ?? normalizeEntrypoints(row?.entrypoints),
    connectedAt: meta?.connectedAt ?? null,
    computer: row ? serializeRow(row, userId) : null,
  };
}

function mintMachineTokenValue(): string {
  return "sk_machine_" + randomBytes(16).toString("hex").slice(0, 32);
}

export function connectCommand(
  serverUrl: string,
  token: string,
  serverName?: string,
  launchCmd = config.DAEMON_LAUNCH_CMD,
): string {
  const origin = serverUrl.replace(/\/+$/, "");
  const base = `${launchCmd} --server-url ${origin} --api-key ${token}`;
  // --server 是运维声明（与 token scope 一致性校验 + 日志可读），不是权限边界
  if (!serverName) return base;
  return `${base} --server "${serverName.replace(/"/g, "")}"`;
}

/**
 * server-scoped 端点的 scope 解析（Q7：必须显式声明，不落 personal 兜底——
 * web apiClient 恒携 x-server-id；非 web 调用方缺 scope → 400，防静默错 scope）。
 * 解析成功返回 serverId（已校验成员身份）；失败已回包并返回 null。
 */
async function requireScope(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const q = (req.query || {}) as Record<string, unknown>;
  const b = (req.body || {}) as Record<string, unknown>;
  const raw = String(q.serverId || b.serverId || req.headers?.[TENANT_HEADER] || "").trim();
  if (!raw) {
    await reply.status(400).send({ error: "serverId required" });
    return null;
  }
  if (!UUID_RE.test(raw)) {
    await reply.status(400).send({ error: "invalid serverId" });
    return null;
  }
  if (!(await isServerMember(app, raw, String((req.user as { sub: string }).sub)))) {
    await reply.status(403).send({ error: "not a member of that server" });
    return null;
  }
  return raw;
}

export async function computerRoutes(app: FastifyInstance) {
  // GET /api/computers?serverId=X — 该 server 全部计算机行（成员可读；操作各端点仍限属主）
  app.get("/", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const serverId = await requireScope(app, req, reply);
    if (!serverId) return;
    const r = await app.pg.query<ComputerRow & { owner_handle: string | null; owner_name: string | null }>(
      `SELECT c.*, u.handle AS owner_handle, u.display_name AS owner_name
         FROM computers c JOIN users u ON u.id = c.user_id
        WHERE c.server_id = $1
        ORDER BY c.last_ready_at DESC NULLS LAST, c.created_at ASC`,
      [serverId],
    );
    const viewerId = String(req.user.sub);
    return {
      computers: r.rows.map((row) => serializeRow(row, viewerId, { handle: row.owner_handle, name: row.owner_name })),
      // Phase 4 rollout 开关：web 据此决定创建表单是否展示 bridge runtime/entrypoint
      bridgeRuntimes: bridgeRuntimesEnabled(),
    };
  });

  // GET /api/computers/me?serverId=X — 我在该 server 的计算机行数组。
  // 过渡形状：computer/connected 字段保留首行与聚合在线，供旧 web 页在 ③ 改造前不崩。
  app.get("/me", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const serverId = await requireScope(app, req, reply);
    if (!serverId) return;
    const userId = String(req.user.sub);
    const r = await app.pg.query<ComputerRow>(
      `SELECT * FROM computers WHERE user_id::text = $1 AND server_id = $2
        ORDER BY last_ready_at DESC NULLS LAST, created_at ASC`,
      [userId, serverId],
    );
    const computers = r.rows.map((row) => serializeRow(row, userId));
    const first = r.rows[0] ?? null;
    return {
      computers,
      // —— 旧形状过渡字段（③ web 上线后由 computers[] 消费，可撤）——
      ...computerStatusPayload(app, userId, first),
    };
  });

  // GET /api/computers/:id — 行详情；该 server 成员可读，mine 标记供 UI 门控操作
  app.get("/:id", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.status(400).send({ error: "invalid computer id" });
    const r = await app.pg.query<ComputerRow>("SELECT * FROM computers WHERE id = $1", [id]);
    const row = r.rows[0];
    if (!row) return reply.status(404).send({ error: "computer not found" });
    if (!(await isServerMember(app, String(row.server_id), String(req.user.sub)))) {
      return reply.status(403).send({ error: "not a member of that server" });
    }
    return { computer: serializeRow(row, String(req.user.sub)) };
  });

  // PATCH /api/computers/:id — 属主改 name/description（逐机，不再按 user 单行）
  app.patch("/:id", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.status(400).send({ error: "invalid computer id" });
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
    const existing = await app.pg.query<ComputerRow>("SELECT * FROM computers WHERE id = $1", [id]);
    if (existing.rows.length === 0) return reply.status(404).send({ error: "computer not found" });
    if (String(existing.rows[0]!.user_id) !== String(req.user.sub)) {
      return reply.status(403).send({ error: "forbidden" });
    }
    params.push(id);
    const r = await app.pg.query<ComputerRow>(
      `UPDATE computers SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
      params,
    );
    return { computer: serializeRow(r.rows[0]!, String(req.user.sub)) };
  });

  // DELETE /api/computers/:id — 属主删该行；有 agent 绑定此机 → 409
  app.delete("/:id", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.status(400).send({ error: "invalid computer id" });
    const r = await app.pg.query<ComputerRow>("SELECT * FROM computers WHERE id = $1", [id]);
    const row = r.rows[0];
    if (!row) return reply.status(404).send({ error: "computer not found" });
    if (String(row.user_id) !== String(req.user.sub)) return reply.status(403).send({ error: "forbidden" });
    const bound = await app.pg.query<{ c: string }>("SELECT count(*)::text AS c FROM agents WHERE computer_id = $1", [
      id,
    ]);
    const count = Number(bound.rows[0]?.c || 0);
    if (count > 0) {
      return reply.status(409).send({ error: "delete agents bound to this computer first", agentCount: count });
    }
    await app.pg.query("DELETE FROM computers WHERE id = $1", [id]);
    return { ok: true };
  });

  // POST /api/computers/me/token {serverId} — 为该 server 签发机器令牌。
  // owner-only（Q5：与 POST /agents 同口径——只有 owner 能把算力放进 server）。
  // 签发不吊销同 scope 旧钥：同 server 多机各持一枚 token 是合法形态
  // （连接按 machineUuid 分槽，token 不绑机器）；单钥吊销走 DELETE /api/profile/tokens/:id。
  app.post("/me/token", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const userId = String(req.user.sub);
    const serverId = await requireScope(app, req, reply);
    if (!serverId) return;
    if (!(await isOrgOwner(app, serverId, userId))) {
      return reply.status(403).send({ error: "only server owner can attach computers" });
    }

    // 与 /api/profile/machine-token 同口径的持有上限——sk_machine_ 是账号级全权令牌
    const activeCount = await countActiveMachineTokens(app, userId);
    if (activeCount >= MACHINE_TOKEN_MAX_ACTIVE_PER_USER) {
      return reply.status(409).send({
        error: `活跃机器令牌已达上限（${MACHINE_TOKEN_MAX_ACTIVE_PER_USER} 个），请先在令牌列表中吊销不再使用的令牌`,
      });
    }

    const server = await app.pg.query<{ name: string }>("SELECT name FROM servers WHERE id = $1", [serverId]);
    const serverName = server.rows[0]?.name || "server";

    const tokenValue = mintMachineTokenValue();
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
      serverId,
      serverName,
      command: connectCommand(origin, tokenValue, serverName),
      message: "Save this token — it won't be shown again.",
    };
  });
}
