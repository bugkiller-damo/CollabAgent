import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

/**
 * P1.24：daemon→server 成本上报 + people stats costUsd 接真数据。
 *
 * 覆盖：machine token 鉴权、UPSERT GREATEST 单调收敛（重放小值不回退）、
 * agentName 兜底解析、他人 agent fail-closed 丢弃、非法行 skip 不 400、
 * 负载上限 400、people stats agent/human 两口径与无数据 null、days 窗口。
 */

const TODAY = new Date().toISOString().slice(0, 10);

async function mintMachineToken(u: TestUser): Promise<string> {
  const r = await api("/api/profile/machine-token", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: {} });
  expect(r.status).toBe(200);
  return r.data.token as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function sync(token: string, rows: unknown[]) {
  return api("/api/agent-costs/sync", { method: "POST", headers: bearer(token), body: { rows } });
}

describe("POST /api/agent-costs/sync（P1.24）", () => {
  let owner: TestUser, other: TestUser;
  let ownerToken: string, otherToken: string;
  let agentId: string, agentName: string;

  beforeAll(async () => {
    owner = await registerUser();
    other = await registerUser();
    ownerToken = await mintMachineToken(owner);
    otherToken = await mintMachineToken(other);
    agentName = "zzcost_" + Date.now().toString(36);
    const created = await api("/api/agents", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: agentName, displayName: "Cost Agent" },
    });
    expect(created.status).toBe(200);
    const listed = await api("/api/agents", { cookie: owner.cookie });
    const row = (listed.data.agents as { id: string; name: string }[]).find((a) => a.name === agentName);
    expect(row).toBeTruthy();
    agentId = row!.id;
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("未认证 401", async () => {
    const r = await api("/api/agent-costs/sync", { method: "POST", body: { rows: [] } });
    expect(r.status).toBe(401);
  });

  it("上报落库；重放更小值不回退（GREATEST 单调），更大值覆盖", async () => {
    const r1 = await sync(ownerToken, [{ agentId, channel: "general", day: TODAY, costUsd: 1.5 }]);
    expect(r1.status).toBe(200);
    expect(r1.data).toEqual({ ok: true, applied: 1, skipped: 0 });

    const db1 =
      await sql`SELECT cost_usd::float8 AS usd FROM agent_cost_daily WHERE agent_id = ${agentId} AND channel = 'general'`;
    expect(Number(db1[0]!.usd)).toBeCloseTo(1.5, 6);

    // daemon 重试重放同一批（值更小）→ 不重复计费也不回退
    const r2 = await sync(ownerToken, [{ agentId, channel: "general", day: TODAY, costUsd: 0.5 }]);
    expect(r2.data.applied).toBe(1);
    const db2 =
      await sql`SELECT cost_usd::float8 AS usd FROM agent_cost_daily WHERE agent_id = ${agentId} AND channel = 'general'`;
    expect(Number(db2[0]!.usd)).toBeCloseTo(1.5, 6);

    const r3 = await sync(ownerToken, [{ agentId, channel: "general", day: TODAY, costUsd: 2.0 }]);
    expect(r3.data.applied).toBe(1);
    const db3 =
      await sql`SELECT cost_usd::float8 AS usd FROM agent_cost_daily WHERE agent_id = ${agentId} AND channel = 'general'`;
    expect(Number(db3[0]!.usd)).toBeCloseTo(2.0, 6);
  });

  it("agentId 缺省时按 agentName 兜底解析（本人名下）", async () => {
    const r = await sync(ownerToken, [{ agentName, channel: "ops", day: TODAY, costUsd: 0.25 }]);
    expect(r.status).toBe(200);
    expect(r.data.applied).toBe(1);
    const db =
      await sql`SELECT cost_usd::float8 AS usd FROM agent_cost_daily WHERE agent_id = ${agentId} AND channel = 'ops'`;
    expect(Number(db[0]!.usd)).toBeCloseTo(0.25, 6);
  });

  it("他人 agent 的行 fail-closed 丢弃，不泄露存在性", async () => {
    const r = await sync(otherToken, [
      { agentId, channel: "general", day: TODAY, costUsd: 99 },
      { agentName, channel: "general", day: TODAY, costUsd: 99 },
    ]);
    expect(r.status).toBe(200);
    expect(r.data.applied).toBe(0);
    expect(r.data.skipped).toBe(2);
    const db =
      await sql`SELECT cost_usd::float8 AS usd FROM agent_cost_daily WHERE agent_id = ${agentId} AND channel = 'general'`;
    expect(Number(db[0]!.usd)).toBeCloseTo(2.0, 6);
  });

  it("非法行逐条 skip 不 400：非正数 / 坏 day / 未知 agent", async () => {
    const r = await sync(ownerToken, [
      { agentId, channel: "general", day: TODAY, costUsd: 0 },
      { agentId, channel: "general", day: TODAY, costUsd: -1 },
      { agentId, channel: "general", day: "2026-13-40", costUsd: 1 },
      { agentId, channel: "general", day: "not-a-date", costUsd: 1 },
      { agentId: "00000000-0000-0000-0000-00000000000x", channel: "g", day: TODAY, costUsd: 1 },
      { agentName: "zz_no_such_agent", channel: "g", day: TODAY, costUsd: 1 },
      { channel: "g", day: TODAY, costUsd: 1 },
    ]);
    expect(r.status).toBe(200);
    expect(r.data.applied).toBe(0);
    expect(r.data.skipped).toBe(7);
  });

  it("负载校验：rows 非数组 / 超上限 400", async () => {
    const bad = await api("/api/agent-costs/sync", {
      method: "POST",
      headers: bearer(ownerToken),
      body: { rows: "x" },
    });
    expect(bad.status).toBe(400);
    const many = await sync(
      ownerToken,
      Array.from({ length: 201 }, (_, i) => ({ agentId, channel: `c${i}`, day: TODAY, costUsd: 0.01 })),
    );
    expect(many.status).toBe(400);
  });

  it("people stats 接真数据：agent 对端=该 agent 合计；human 对端=名下 agents 合计；无数据 null", async () => {
    const created2 = await api("/api/agents", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: agentName + "_b", displayName: "Broke Agent" },
    });
    expect(created2.status).toBe(200);

    const agentStats = await api(`/api/people/${agentName}/stats?days=7`, { cookie: owner.cookie });
    expect(agentStats.status).toBe(200);
    expect(agentStats.data.costUsd).not.toBeNull();
    expect(agentStats.data.costUsd).toBeCloseTo(2.25, 6); // general 2.0 + ops 0.25

    const humanStats = await api(`/api/people/${owner.handle}/stats?days=7`, { cookie: owner.cookie });
    expect(humanStats.status).toBe(200);
    expect(humanStats.data.costUsd).toBeCloseTo(2.25, 6);

    const broke = await api(`/api/people/${agentName}_b/stats?days=7`, { cookie: owner.cookie });
    expect(broke.status).toBe(200);
    expect(broke.data.costUsd).toBeNull();

    const none = await api(`/api/people/${other.handle}/stats?days=7`, { cookie: other.cookie });
    expect(none.status).toBe(200);
    expect(none.data.costUsd).toBeNull();
  });

  it("days 窗口收窄排除旧日成本", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const r = await sync(ownerToken, [{ agentId, channel: "legacy", day: yesterday, costUsd: 7 }]);
    expect(r.status).toBe(200);
    const todayOnly = await api(`/api/people/${agentName}/stats?days=1`, { cookie: owner.cookie });
    expect(todayOnly.data.costUsd).toBeCloseTo(2.25, 6); // 不含 legacy 行
    const window = await api(`/api/people/${agentName}/stats?days=2`, { cookie: owner.cookie });
    expect(window.data.costUsd).toBeCloseTo(9.25, 6);
  });
});
