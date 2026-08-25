import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("GET /api/people/:handle", () => {
  let ck: string, cs: string, peerHandle: string, agentName: string, channelId: string, channelName: string;

  beforeAll(async () => {
    const me = await registerUser();
    ck = me.cookie;
    cs = me.csrf;
    const peer = await registerUser();
    peerHandle = peer.handle;
    agentName = "ag_" + Date.now().toString(36);
    const created = await api("/api/agents", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: agentName, displayName: "Coder", description: "写代码的人" },
    });
    expect(created.status).toBe(200);
    const ch = await api("/api/channels", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: "ppl_" + Date.now().toString(36) },
    });
    channelId = ch.data.channel.id;
    channelName = ch.data.channel.name;
    await api(`/api/channels/${channelId}/invite`, {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { handle: peerHandle },
    });
    await api(`/api/channels/${channelId}/invite`, {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { handle: agentName },
    });
  });

  it("未登录 401", async () => {
    const r = await api(`/api/people/${peerHandle}`);
    expect(r.status).toBe(401);
  });

  it("人类档案含 bio，不含 runtime", async () => {
    const r = await api(`/api/people/${peerHandle}`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.type).toBe("human");
    expect(r.data.handle).toBe(peerHandle);
    expect(r.data).toHaveProperty("description");
    expect(r.data).toHaveProperty("createdAt");
    expect(r.data.runtime).toBeUndefined();
    expect(Array.isArray(r.data.channels)).toBe(true);
  });

  it("Agent 档案含 runtime / model / isOnline", async () => {
    const r = await api(`/api/people/${agentName}`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.type).toBe("agent");
    expect(r.data.handle).toBe(agentName);
    expect(r.data.description).toBe("写代码的人");
    expect(r.data.runtime).toBeTruthy();
    expect(r.data.model).toBeTruthy();
    expect(r.data.isOnline).toBe(false);
    expect(r.data.duty).toBe("on");
    expect(r.data.presence).toBe("computer_offline");
  });

  it("同名 user 优先于 agent", async () => {
    const clash = await api("/api/agents", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { name: peerHandle, displayName: "Clash" },
    });
    expect(clash.status).toBe(200);
    const r = await api(`/api/people/${peerHandle}`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.type).toBe("human");
    expect(r.data.handle).toBe(peerHandle);
  });

  it("?channelId= 带回角色", async () => {
    const r = await api(`/api/people/${peerHandle}?channelId=${channelId}`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(r.data.channel).toBeTruthy();
    expect(r.data.channel.id).toBe(channelId);
    expect(r.data.channel.role).toBeTruthy();
    expect(r.data.channel.isManager).toBe(false);
  });

  it("未知 handle 404", async () => {
    const r = await api("/api/people/no_such_person_zz", { cookie: ck });
    expect(r.status).toBe(404);
  });

  it("GET /stats 返回近 7 天计数", async () => {
    await api("/api/messages/send", {
      method: "POST",
      cookie: ck,
      csrf: cs,
      body: { target: `#${channelName}`, content: "stats ping" },
    });
    const r = await api(`/api/people/${peerHandle}/stats?days=7`, { cookie: ck });
    expect(r.status).toBe(200);
    expect(typeof r.data.messages).toBe("number");
    expect(typeof r.data.tasksOpen).toBe("number");
    expect(typeof r.data.tasksDone).toBe("number");
    expect(r.data.costUsd).toBeNull();
  });

  it("档案含 lastMessageAt；Agent 可带 computer", async () => {
    const human = await api(`/api/people/${peerHandle}`, { cookie: ck });
    expect(human.status).toBe(200);
    expect(human.data).toHaveProperty("lastMessageAt");
    const agent = await api(`/api/people/${agentName}`, { cookie: ck });
    expect(agent.status).toBe(200);
    expect(agent.data).toHaveProperty("computer");
  });

  it("档案频道带 type / description；含私信", async () => {
    const r = await api(`/api/people/${peerHandle}`, { cookie: ck });
    expect(r.status).toBe(200);
    const ch = (r.data.channels as { name: string; type?: string; description?: string | null }[]).find(
      (c) => c.name === channelName,
    );
    expect(ch).toBeTruthy();
    expect(ch!.type).toBe("public");
    expect(ch!).toHaveProperty("description");
  });

  it("GET /api/agents/:id/workspace — owner 在计算机离线时 503", async () => {
    const listed = await api("/api/agents", { cookie: ck });
    const row = (listed.data.agents as { id: string; name: string }[]).find((a) => a.name === agentName);
    expect(row).toBeTruthy();
    const r = await api(`/api/agents/${row!.id}/workspace`, { cookie: ck });
    expect(r.status).toBe(503);
    expect(r.data.error).toMatch(/offline/i);
  });
});
