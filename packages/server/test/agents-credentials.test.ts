import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

// P1.28：agent scoped 凭据生命周期（/internal/agent/:agentId/credentials）——此前零覆盖
//（评估 §2.6 零覆盖清单 ③，安全敏感面）。覆盖：签发（sk_agent_ 前缀 + 24h TTL）→
// 使用（scoped token 过 authenticate 的 agentId 单条索引路径）→ 轮换（重新签发即撤销
// 旧的，upsert 语义）→ 吊销 → 失效；防自续期/自吊销（requireMachineAuth，TTL 边界
// 不允许 scoped token 自己续命）；跨 agent 冒用 401。

let owner: TestUser;
let agentId = "";
let secondAgentId = "";
let machineToken = "";

beforeAll(async () => {
  owner = await registerUser();
  for (const [name, setter] of [
    ["cred_a", (id: string) => (agentId = id)],
    ["cred_b", (id: string) => (secondAgentId = id)],
  ] as const) {
    const r = await api("/api/agents", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: `${name}_${Date.now().toString(36)}`, displayName: "CredTest" },
    });
    expect(r.status).toBe(200);
    setter(r.data.agent.id);
  }
  const mt = await api("/api/profile/machine-token", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: {},
  });
  expect(mt.status).toBe(200);
  machineToken = mt.data.token;
});

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("agent 凭据生命周期：签发 → 使用 → 轮换 → 吊销", () => {
  it("签发：sk_agent_ 前缀 + expiresAt ≈ 24h（23~25h 窗口断言）", async () => {
    const r = await api(`/internal/agent/${agentId}/credentials`, { method: "POST", token: machineToken, body: {} });
    expect(r.status).toBe(200);
    expect(r.data.agentId).toBe(agentId);
    expect(r.data.token).toMatch(/^sk_agent_[A-Za-z0-9_-]{32,}$/);
    const ttl = new Date(r.data.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3600 * 1000);
    expect(ttl).toBeLessThan(25 * 3600 * 1000);
  });

  it("使用：scoped token 走 :agentId 路由（单条索引认证路径）→ 200", async () => {
    const mint = await api(`/internal/agent/${agentId}/credentials`, { method: "POST", token: machineToken, body: {} });
    const token: string = mint.data.token;
    const use = await api(`/internal/agent/${agentId}/server`, { token });
    expect(use.status).toBe(200);
    expect(use.data.serverId).toBeTruthy();
  });

  it("防自续期/自吊销：scoped token 调 credentials 端点 → 403（须账号级 machine token）", async () => {
    const mint = await api(`/internal/agent/${agentId}/credentials`, { method: "POST", token: machineToken, body: {} });
    const token: string = mint.data.token;
    const renew = await api(`/internal/agent/${agentId}/credentials`, { method: "POST", token, body: {} });
    expect(renew.status).toBe(403);
    expect(renew.data.error).toContain("account-level machine token");
    const revoke = await api(`/internal/agent/${agentId}/credentials`, { method: "DELETE", token });
    expect(revoke.status).toBe(403);
    // 未遂后凭据仍有效（TTL 边界未被绕过）
    expect((await api(`/internal/agent/${agentId}/server`, { token })).status).toBe(200);
  });

  it("跨 agent 冒用：scoped token 用在另一 agent 路由 → 401", async () => {
    const mint = await api(`/internal/agent/${agentId}/credentials`, { method: "POST", token: machineToken, body: {} });
    const token: string = mint.data.token;
    // 同 owner 的另一个 agent：requireOwnAgent 还没跑到，authenticate 按该 agentId 查
    // agent_credentials 无匹配哈希 → 401（scope 只在其 agentId 范围内有效）
    const r = await api(`/internal/agent/${secondAgentId}/server`, { token });
    expect(r.status).toBe(401);
    expect(r.data.error).toContain("Invalid");
  });

  it("轮换：重新签发即撤销旧的（upsert）——旧 token 401、新 token 200", async () => {
    const first = await api(`/internal/agent/${agentId}/credentials`, {
      method: "POST",
      token: machineToken,
      body: {},
    });
    const oldToken: string = first.data.token;
    const second = await api(`/internal/agent/${agentId}/credentials`, {
      method: "POST",
      token: machineToken,
      body: {},
    });
    expect(second.status).toBe(200);
    const newToken: string = second.data.token;
    expect(newToken).not.toBe(oldToken);
    expect((await api(`/internal/agent/${agentId}/server`, { token: oldToken })).status).toBe(401);
    expect((await api(`/internal/agent/${agentId}/server`, { token: newToken })).status).toBe(200);
  });

  it("吊销：machine token DELETE → ok；再使用 → 401；重复吊销幂等 ok（best-effort 语义）", async () => {
    const mint = await api(`/internal/agent/${agentId}/credentials`, { method: "POST", token: machineToken, body: {} });
    const token: string = mint.data.token;
    expect((await api(`/internal/agent/${agentId}/server`, { token })).status).toBe(200);

    const rev = await api(`/internal/agent/${agentId}/credentials`, { method: "DELETE", token: machineToken });
    expect(rev.status).toBe(200);
    expect(rev.data.ok).toBe(true);
    expect((await api(`/internal/agent/${agentId}/server`, { token })).status).toBe(401);

    const revAgain = await api(`/internal/agent/${agentId}/credentials`, { method: "DELETE", token: machineToken });
    expect(revAgain.status).toBe(200); // 无可撤销凭据也 ok，不当错误
  });

  it("凭据行验证：agent_id 唯一（一 agent 同时至多一条有效凭据）+ sha256 落库", async () => {
    const mint1 = await api(`/internal/agent/${agentId}/credentials`, {
      method: "POST",
      token: machineToken,
      body: {},
    });
    const rows = await sql<
      { token_hash: string }[]
    >`SELECT token_hash FROM agent_credentials WHERE agent_id = ${agentId} AND revoked_at IS NULL`;
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).toBe(createHash("sha256").update(mint1.data.token).digest("hex"));
    await api(`/internal/agent/${agentId}/credentials`, { method: "DELETE", token: machineToken });
  });
});
