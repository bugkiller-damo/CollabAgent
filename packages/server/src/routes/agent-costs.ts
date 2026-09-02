import type { FastifyInstance } from "fastify";

/**
 * P1.24：daemon→server 成本上报。
 *
 * daemon（cost-reporter）定期把本地账本（.slock/daemon-costs.json）的
 * 「当日累计绝对值」批量 POST 到这里。表结构与语义见
 * db/migrations/022_agent_cost_daily.sql 头注释：
 *   * daemon 账本由 createSessionCostDelta 按「本次 − 上次」增量累计，
 *     上报的是增量之和（当日累计），不是 Claude 会话累计原值；
 *   * UPSERT 取 GREATEST 单调收敛——重试 / 乱序 / 账本重置不重复计费，
 *     无需 ack 协议；
 *   * 归属校验 fail-closed：agentId/agentName 解析不到「调用者本人名下的
 *     agent」即丢弃该行（不 400，daemon 不因个别脏行中断整批上报）。
 *
 * 鉴权走 app.authenticate 的 sk_machine_ 分支（daemon 账号级令牌），
 * Bearer 无 cookie 会话，无 CSRF 面。
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 200;
const MAX_CHANNEL_LEN = 128;

interface SyncRow {
  agentId?: unknown;
  agentName?: unknown;
  channel?: unknown;
  day?: unknown;
  costUsd?: unknown;
}

export async function agentCostRoutes(app: FastifyInstance) {
  app.post("/sync", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const body = (req.body || {}) as { rows?: unknown };
    if (!Array.isArray(body.rows)) return reply.status(400).send({ error: "rows must be an array" });
    if (body.rows.length > MAX_ROWS) return reply.status(400).send({ error: `too many rows (max ${MAX_ROWS})` });

    // 一次取回调用者名下全部 agent，批量解析（byId 优先——id 跨改名稳定）
    const userId = String(req.user.sub);
    const mine = await app.pg.query<{ id: string; name: string }>("SELECT id, name FROM agents WHERE user_id = $1", [
      userId,
    ]);
    const byId = new Map(mine.rows.map((r) => [String(r.id), r]));
    const byName = new Map(mine.rows.map((r) => [r.name, r]));

    // 同键多行（理论不该发生）取大者；非法行 skip 计数不 400
    const merged = new Map<string, { agentId: string; channel: string; day: string; costUsd: number }>();
    let skipped = 0;
    for (const raw of body.rows as SyncRow[]) {
      const costUsd =
        typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd > 0 ? raw.costUsd : null;
      const day =
        typeof raw.day === "string" && DAY_RE.test(raw.day) && !Number.isNaN(Date.parse(`${raw.day}T00:00:00Z`))
          ? raw.day
          : null;
      const channel =
        typeof raw.channel === "string" && raw.channel.trim() !== ""
          ? raw.channel.trim().slice(0, MAX_CHANNEL_LEN)
          : null;
      if (costUsd == null || day == null || channel == null) {
        skipped++;
        continue;
      }
      const agentId =
        (typeof raw.agentId === "string" && byId.get(raw.agentId)?.id) ||
        (typeof raw.agentName === "string" && byName.get(raw.agentName)?.id);
      if (!agentId) {
        // 不存在 / 不是调用者的 agent——丢弃不泄露存在性（对齐 P0.4 404 语义）
        skipped++;
        continue;
      }
      const key = `${agentId}\0${channel}\0${day}`;
      const prev = merged.get(key);
      if (!prev || costUsd > prev.costUsd) merged.set(key, { agentId, channel, day, costUsd });
    }

    const values = Array.from(merged.values());
    if (values.length > 0) {
      const params: unknown[] = [];
      const tuples = values.map((v) => {
        params.push(v.agentId, v.channel, v.day, v.costUsd);
        const i = params.length;
        return `($${i - 3}::uuid, $${i - 2}, $${i - 1}::date, $${i}::numeric)`;
      });
      // GREATEST：EXCLUDED 更小（重试重放 / 账本重置）时保留现值，单调不回退。
      // INSERT 列清单不含 updated_at（走 DEFAULT now()）；更新分支显式刷新。
      await app.pg.query(
        `INSERT INTO agent_cost_daily AS t (agent_id, channel, day, cost_usd)
         VALUES ${tuples.join(",")}
         ON CONFLICT (agent_id, channel, day) DO UPDATE
           SET cost_usd = GREATEST(t.cost_usd, EXCLUDED.cost_usd),
               updated_at = now()`,
        params,
      );
    }
    return { ok: true, applied: values.length, skipped };
  });
}
