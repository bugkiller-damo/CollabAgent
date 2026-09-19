import { afterAll, describe, expect, it } from "vitest";
import {
  api,
  cleanupTestData,
  closeSql,
  ensureTestComputer,
  registerUser,
  sql,
  type TestUser,
  uniqHandle,
} from "./helpers.js";

// DM 私信区 server 作用域（修复「新建 server 的私信区显示历史私信记录」）：
// - GET /api/channels/dms 显式租户（x-server-id）下按 server 过滤——此前
//   无 server 过滤，dm 频道集中停广场，任何 server 语境列出同一份全局列表；
// - getOrCreateDmChannel 新建 dm 频道停进「对话双方共有的 server」
//   （调用方语境双方皆成员 → 双方共有的最早社区 server → 默认社区兜底）；
//   有 agent 一方仍归 agent 所属 server；已存在的 dm 频道位置不动
//   （dm_<idA>_<idB> 全局唯一）。

async function createOrg(cookie: string, name = "zz_test_dms") {
  const r = await api("/api/orgs", { method: "POST", cookie, body: { name } });
  expect(r.status).toBe(200);
  return r.data.org as { id: string; name: string };
}

async function plazaId(): Promise<string> {
  const rows = await sql`SELECT id FROM servers WHERE is_public = true ORDER BY created_at ASC LIMIT 1`;
  expect(rows.length).toBe(1);
  return String(rows[0].id);
}

async function dmChannelServerId(channelKey: string): Promise<string> {
  const id = channelKey.replace(/^dm:/, "");
  const rows = await sql`SELECT server_id::text AS server_id FROM channels WHERE id = ${id}`;
  expect(rows.length).toBe(1);
  return String(rows[0].server_id);
}

function dmsUnder(user: TestUser, serverId: string) {
  return api("/api/channels/dms", { cookie: user.cookie, headers: { "x-server-id": serverId } });
}

async function sendDm(user: TestUser, peerHandle: string, serverId: string, content = "hi"): Promise<string> {
  const r = await api("/api/messages/send", {
    method: "POST",
    cookie: user.cookie,
    headers: { "x-server-id": serverId },
    body: { target: `dm:@${peerHandle}`, content },
  });
  expect(r.status).toBe(200);
  return r.data.channelId as string; // "dm:<uuid>"
}

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("dm scope: /dms 按活跃 server 过滤", () => {
  it("共有 server 下发 DM → 频道停进共有 server；该语境双方可见，新建空 server 语境为空", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const org = await createOrg(a.cookie);
    const add = await api(`/api/orgs/${org.id}/members`, {
      method: "POST",
      cookie: a.cookie,
      body: { handle: b.handle },
    });
    expect(add.status).toBe(200);

    // A 在共有 server 语境下发 DM → dm 频道 server_id = 共有 server
    const channelKey = await sendDm(a, b.handle, org.id);
    expect(await dmChannelServerId(channelKey)).toBe(org.id);

    // 双方在共有 server 语境下 /dms 可见该会话
    const dmsA = await dmsUnder(a, org.id);
    expect(dmsA.status).toBe(200);
    expect(dmsA.data.dms.some((d: any) => d.peerHandle === b.handle)).toBe(true);
    const dmsB = await dmsUnder(b, org.id);
    expect(dmsB.status).toBe(200);
    expect(dmsB.data.dms.some((d: any) => d.peerHandle === a.handle)).toBe(true);

    // 广场语境不再列出（频道归属 org 而非广场）
    const plaza = await plazaId();
    const plazaA = await dmsUnder(a, plaza);
    expect(plazaA.status).toBe(200);
    expect(plazaA.data.dms.some((d: any) => d.peerHandle === b.handle)).toBe(false);

    // 核心 bug 断言：各自新建空 server → /dms 空数组（不再显示全局历史私信）
    const emptyA = await createOrg(a.cookie, "zz_test_dms_empty_a");
    const emptyB = await createOrg(b.cookie, "zz_test_dms_empty_b");
    expect((await dmsUnder(a, emptyA.id)).data.dms).toEqual([]);
    expect((await dmsUnder(b, emptyB.id)).data.dms).toEqual([]);

    // 无租户头的旧调用方兼容：非显式租户不加过滤（全局列表）
    const legacy = await api("/api/channels/dms", { cookie: a.cookie });
    expect(legacy.status).toBe(200);
    expect(legacy.data.dms.some((d: any) => d.peerHandle === b.handle)).toBe(true);

    // 已有 dm 频道位置不动：换广场语境再发仍命中同一频道、仍归属 org
    const again = await sendDm(a, b.handle, plaza, "again");
    expect(again).toBe(channelKey);
    expect(await dmChannelServerId(again)).toBe(org.id);
  });

  it("无共有社区 server（仅广场共有）→ dm 落广场；广场语境 /dms 可见", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const plaza = await plazaId();
    // 调用方语境为对端不在场的私有 server → 落点跳过 ①② 退回广场兜底
    const solo = await createOrg(a.cookie, "zz_test_dms_solo");
    const channelKey = await sendDm(a, b.handle, solo.id);
    expect(await dmChannelServerId(channelKey)).toBe(plaza);

    const plazaA = await dmsUnder(a, plaza);
    expect(plazaA.data.dms.some((d: any) => d.peerHandle === b.handle)).toBe(true);
    const plazaB = await dmsUnder(b, plaza);
    expect(plazaB.data.dms.some((d: any) => d.peerHandle === a.handle)).toBe(true);
  });

  it("agent DM：dm 频道 server_id = agent 所属 server（回归）", async () => {
    const a = await registerUser();
    const org = await createOrg(a.cookie);
    await ensureTestComputer(a, org.id);
    const ag = await api("/api/agents", {
      method: "POST",
      cookie: a.cookie,
      body: { name: "zzdmbot" + uniqHandle().slice(-6), serverId: org.id },
    });
    expect(ag.status).toBe(200);
    const agentName = ag.data.agent.name as string;

    const channelKey = await sendDm(a, agentName, org.id);
    expect(await dmChannelServerId(channelKey)).toBe(org.id);

    const dmsA = await dmsUnder(a, org.id);
    expect(dmsA.data.dms.some((d: any) => d.peerHandle === agentName && d.peerType === "agent")).toBe(true);
  });

  it("显式租户且非该 server 成员 → 403", async () => {
    const a = await registerUser();
    const outsider = await registerUser();
    const org = await createOrg(a.cookie);
    const r = await dmsUnder(outsider, org.id);
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("not a member of that server");
  });
});
