import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { api, BASE, cleanupTestData, closeSql, ensureTestComputer, registerUser, sql, uniqHandle } from "./helpers.js";

/**
 * Phase 4：bridge runtime（langchain/langgraph）创建/编辑门禁的端到端矩阵。
 *
 * 测试形态：fake daemon 用 machine-token 建 WS 并发 ready（带 entrypoints），
 * server 侧 meta 即「该机 live probe」。POST/PATCH /agents 按该 probe 复核。
 *
 * rollout flag（SLOCK_BRIDGE_RUNTIMES）自适应：测试实例（test-server.ts）默认开；
 * 回落 dev server 且 flag 关时只断言 flag-off 契约（400 runtime not wired），
 * 不误判环境差异为产品缺陷。
 */

const WS_BASE = BASE.replace(/^http/, "ws") + "/ws";
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

// select 模式 entrypoint（allowlist 单模型）
const EP_SELECT = {
  id: "ep-sel",
  label: "LangGraph Select",
  runtime: "langgraph",
  status: "installed_unsupported",
  version: "0.1.0",
  modelMode: "select",
  models: ["openai:gpt-5-mini"],
  defaultModel: "openai:gpt-5-mini",
  capabilities: { durableThreads: true, interrupts: true },
};
// fixed 模式 entrypoint
const EP_FIXED = {
  id: "ep-fixed",
  label: "LangChain Fixed",
  runtime: "langchain",
  status: "installed",
  modelMode: "fixed",
  defaultModel: "demo:echo",
};
// 探测失败态（创建必须 fail-closed）
const EP_BAD = {
  id: "ep-bad",
  label: "Broken",
  runtime: "langgraph",
  status: "misconfigured",
  modelMode: "fixed",
  errorCode: "manifest_invalid",
};

// GET /api/computers 需要 serverId scope——flag 探测须带显式租户语境
async function flagOn(cookie: string, serverId: string): Promise<boolean> {
  const r = await api(`/api/computers?serverId=${serverId}`, { cookie });
  return r.status === 200 && r.data?.bridgeRuntimes === true;
}

/** 注册用户 → 铺计算机行 → 铸 machine token → fake daemon WS + ready(entrypoints) */
async function fakeDaemonWithEntrypoints(
  u: { cookie: string; csrf: string; userId: string },
  entrypoints: unknown[],
  opts?: { machineUuid?: string },
) {
  const comp = await ensureTestComputer(u, null, opts);
  const tr = await api("/api/profile/machine-token", {
    method: "POST",
    cookie: u.cookie,
    csrf: u.csrf,
    body: { serverId: comp.serverId },
  });
  expect(tr.status).toBe(200);
  const ws = new WebSocket(WS_BASE, { headers: { Authorization: `Bearer ${tr.data.token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once("message", () => resolve());
    ws.once("error", reject);
    setTimeout(() => reject(new Error("daemon ws connect timeout")), 8000);
  });
  ws.send(
    JSON.stringify({
      type: "ready",
      machineUuid: comp.machineUuid,
      hostname: "bridge-test-host",
      daemonVersion: "0.1.0-bridge-test",
      runtimes: [{ id: "claude", status: "installed" }],
      entrypoints,
    }),
  );
  await tick(250);
  return { ws, comp };
}

const readProfile = async (agentId: string) => {
  const rows = await sql<{ runtime_profile: any }[]>`SELECT runtime_profile FROM agents WHERE id = ${agentId}`;
  return rows[0]?.runtime_profile;
};

afterAll(async () => {
  await tick(400);
  await cleanupTestData();
  await closeSql();
});

describe("Phase 4: bridge runtime 创建门禁", () => {
  it("flag 关 → bridge 创建 400 runtime not wired（fail-closed 契约）", async () => {
    const u = await registerUser();
    const comp = await ensureTestComputer(u);
    if (await flagOn(u.cookie, comp.serverId)) return; // flag 开时由下方矩阵覆盖
    const r = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "br_" + uniqHandle(), serverId: comp.serverId, runtime: "langgraph", entrypoint: "ep-sel" },
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/runtime not wired/);
  });

  it("无 entrypoint → 400；claude + entrypoint → 400（flag 无关的静态门禁）", async () => {
    const u = await registerUser();
    const comp = await ensureTestComputer(u);
    const noEp = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "br_" + uniqHandle(), serverId: comp.serverId, runtime: "langgraph" },
    });
    expect(noEp.status).toBe(400);
    // flag 关：not wired；flag 开：entrypoint required——两种都是 400 且消息指 entrypoint/runtime
    expect(noEp.data.error).toMatch(/entrypoint|runtime/);

    const claudeEp = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { name: "br_" + uniqHandle(), serverId: comp.serverId, runtime: "claude", entrypoint: "ep-sel" },
    });
    expect(claudeEp.status).toBe(400);
    expect(claudeEp.data.error).toMatch(/entrypoint/);
  });

  it("flag 开 + fake daemon ready(entrypoints) → 完整门禁矩阵", async () => {
    const u = await registerUser();
    const { ws, comp } = await fakeDaemonWithEntrypoints(u, [EP_SELECT, EP_FIXED, EP_BAD]);
    if (!(await flagOn(u.cookie, comp.serverId))) {
      ws.close();
      return; // dev 回落无 flag——矩阵由测试实例跑
    }

    // ready → GET /api/computers 透出 entrypoints（meta → API 端到端）
    const computers = await api(`/api/computers?serverId=${comp.serverId}`, { cookie: u.cookie });
    const row = (computers.data.computers as any[]).find((c) => c.id === comp.id);
    expect(row?.entrypoints?.map((e: any) => e.id).sort()).toEqual(["ep-bad", "ep-fixed", "ep-sel"]);
    // 敏感面不外泄：probe 摘要不带 command/cwd/env
    expect(JSON.stringify(row.entrypoints)).not.toMatch(/command|secretEnv|cwd/);

    const post = (body: Record<string, unknown>) =>
      api("/api/agents", { method: "POST", cookie: u.cookie, csrf: u.csrf, body });

    // 该机没有的 entrypoint → fail closed
    const ghost = await post({
      name: "br_" + uniqHandle(),
      serverId: comp.serverId,
      runtime: "langgraph",
      entrypoint: "ghost-ep",
    });
    expect(ghost.status).toBe(400);
    expect(ghost.data.code).toBe("entrypoint_unavailable");

    // runtime 不匹配（ep-sel 属 langgraph，按 langchain 创建）→ 同 400
    const wrongRt = await post({
      name: "br_" + uniqHandle(),
      serverId: comp.serverId,
      runtime: "langchain",
      entrypoint: "ep-sel",
    });
    expect(wrongRt.status).toBe(400);
    expect(wrongRt.data.code).toBe("entrypoint_unavailable");

    // probe 失败态（misconfigured）→ not_ready
    const bad = await post({
      name: "br_" + uniqHandle(),
      serverId: comp.serverId,
      runtime: "langgraph",
      entrypoint: "ep-bad",
    });
    expect(bad.status).toBe(400);
    expect(bad.data.code).toBe("entrypoint_not_ready");
    expect(bad.data.entrypointStatus).toBe("misconfigured");

    // select 模式：模型不在 allowlist → model_not_allowed
    const badModel = await post({
      name: "br_" + uniqHandle(),
      serverId: comp.serverId,
      runtime: "langgraph",
      entrypoint: "ep-sel",
      model: "openai:ft-hacked",
    });
    expect(badModel.status).toBe(400);
    expect(badModel.data.code).toBe("model_not_allowed");

    // fixed 模式：显式覆盖模型 → model_fixed
    const fixedOverride = await post({
      name: "br_" + uniqHandle(),
      serverId: comp.serverId,
      runtime: "langchain",
      entrypoint: "ep-fixed",
      model: "openai:gpt-5-mini",
    });
    expect(fixedOverride.status).toBe(400);
    expect(fixedOverride.data.code).toBe("model_fixed");

    // 合法创建：select + 缺省模型 → 落库 defaultModel + entrypoint
    const ok = await post({
      name: "br_" + uniqHandle(),
      serverId: comp.serverId,
      runtime: "langgraph",
      entrypoint: "ep-sel",
    });
    expect(ok.status).toBe(200);
    const agentId = ok.data.agent.id as string;
    expect(await readProfile(agentId)).toMatchObject({
      runtime: "langgraph",
      model: "openai:gpt-5-mini",
      entrypoint: "ep-sel",
    });

    // PATCH：bridge agent 的模型编辑仍走 probe 策略
    const badPatch = await api(`/api/agents/${agentId}`, {
      method: "PATCH",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { model: "openai:ft-hacked" },
    });
    expect(badPatch.status).toBe(400);
    expect(badPatch.data.code).toBe("model_not_allowed");

    // PATCH model 合法值 → 200，entrypoint 保留
    const okPatch = await api(`/api/agents/${agentId}`, {
      method: "PATCH",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { model: "openai:gpt-5-mini" },
    });
    expect(okPatch.status).toBe(200);
    expect((await readProfile(agentId))?.entrypoint).toBe("ep-sel");

    // PATCH 残留 entrypoint 切回 claude → 400；同请求清 entrypoint → 200
    const resid = await api(`/api/agents/${agentId}`, {
      method: "PATCH",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { runtime: "claude" },
    });
    expect(resid.status).toBe(400);
    const cleared = await api(`/api/agents/${agentId}`, {
      method: "PATCH",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { runtime: "claude", entrypoint: "" },
    });
    expect(cleared.status).toBe(200);
    expect(await readProfile(agentId)).toMatchObject({ runtime: "claude" });
    expect((await readProfile(agentId))?.entrypoint).toBeUndefined();

    // 反向：claude agent PATCH 回 bridge runtime + entrypoint → 同门禁放行
    const back = await api(`/api/agents/${agentId}`, {
      method: "PATCH",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { runtime: "langgraph", entrypoint: "ep-sel" },
    });
    expect(back.status).toBe(200);
    expect(await readProfile(agentId)).toMatchObject({ runtime: "langgraph", entrypoint: "ep-sel" });

    ws.close();
  });

  it("entrypoint 不跨机：computer B 的 meta 不含 A 的条目 → 400", async () => {
    const u = await registerUser();
    // A 机：fake daemon 带 ep-sel
    const a = await fakeDaemonWithEntrypoints(u, [EP_SELECT]);
    // B 机：第二个 machineUuid、无 daemon（meta 缺失 = 离线/旧 daemon）
    const b = await ensureTestComputer(u, a.comp.serverId, { machineUuid: crypto.randomUUID(), name: "m-b" });
    if (!(await flagOn(u.cookie, a.comp.serverId))) {
      a.ws.close();
      return;
    }
    const r = await api("/api/agents", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: {
        name: "br_" + uniqHandle(),
        serverId: a.comp.serverId,
        computerId: b.id,
        runtime: "langgraph",
        entrypoint: "ep-sel", // A 机的条目，B 机 meta 里不存在
      },
    });
    expect(r.status).toBe(400);
    expect(r.data.code).toBe("entrypoint_unavailable");
    a.ws.close();
  });
});
