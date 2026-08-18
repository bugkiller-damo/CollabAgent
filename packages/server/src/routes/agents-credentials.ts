import type { FastifyInstance } from "fastify";
import { requireOwnAgent } from "../lib/agent-helpers.js";
import { sha256Token } from "../lib/token-hash.js";

/**
 * Per-agent-run scoped token（对应 agent_credentials 表 —— 之前只有 schema/迁移，
 * 没有任何应用代码用过）。daemon 在 spawn 一个 agent PTY 时调用 mint 换一个
 * sk_agent_... token 注入子进程 env，取代之前"共享同一个账号级 apiKey"的临时方案；
 * PTY 退出时调用 revoke。
 *
 * agent_credentials.agent_id / token_hash 都是 UNIQUE —— 一个 agent 同一时刻只有
 * 一条有效凭证，mint 用 upsert 覆盖旧的一条，天然实现"重新签发即撤销旧的"语义。
 */

const TOKEN_PREFIX = "sk_agent_";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h：足够覆盖单次长会话，daemon 重启后下次 dispatch 会自然重新 mint

function generateToken(): string {
  const randomPart = Array.from(
    { length: 32 },
    () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)],
  ).join("");
  return TOKEN_PREFIX + randomPart;
}

/** 防止一个已签发的 scoped token 自己给自己续期/自己撤销自己——必须用账号级
 * machine token 来管理凭证，scoped token 只能拿去调业务接口。否则 TTL 这道
 * 安全边界形同虚设（万一 token 泄露，攻击者可以无限自我续期）。 */
function requireMachineAuth(req: any, reply: any): boolean {
  if (req.user?.scope === "agent-run") {
    reply.status(403).send({ error: "must authenticate with an account-level machine token" });
    return false;
  }
  return true;
}

export async function agentCredentialRoutes(app: FastifyInstance) {
  // 签发/刷新（每次 spawn 调用一次）—— 覆盖同一 agent 之前的凭证
  app.post("/:agentId/credentials", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    if (!requireMachineAuth(req, reply)) return;
    const agentId = (req.params as Record<string, string>).agentId;
    const token = generateToken();
    // sha256 落库（lib/token-hash.ts）：spawn/verify 热路径 O(1) 索引命中
    const hash = sha256Token(token);
    const expiresAt = new Date(Date.now() + TTL_MS);
    await app.pg.query(
      `INSERT INTO agent_credentials (agent_id, token_hash, token_prefix, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (agent_id) DO UPDATE SET
         token_hash = EXCLUDED.token_hash,
         token_prefix = EXCLUDED.token_prefix,
         expires_at = EXCLUDED.expires_at,
         revoked_at = NULL,
         created_at = now()`,
      [agentId, hash, TOKEN_PREFIX, expiresAt.toISOString()],
    );
    return { token, agentId, expiresAt: expiresAt.toISOString() };
  });

  // 撤销（PTY 退出时调用，best-effort：没有可撤销的凭证也返回 ok，不当错误处理）
  app.delete("/:agentId/credentials", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    if (!requireMachineAuth(req, reply)) return;
    const agentId = (req.params as Record<string, string>).agentId;
    await app.pg.query("UPDATE agent_credentials SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL", [
      agentId,
    ]);
    return { ok: true };
  });
}
