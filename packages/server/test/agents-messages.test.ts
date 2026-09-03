import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser, uniqHandle } from "./helpers.js";

// P1.28：agent 侧消息面（/internal/agent/:agentId/…）集成测试——此前 12 个端点约 330
// 行零覆盖（评估 §2.6 零覆盖清单 ①）。覆盖：send（公开/私有/越权/未入圈）、
// requireOwnAgent 403 矩阵、sk_agent_ scoped token 认证路径、edit/delete 自有消息、
// receive 游标语义（首置 MAX(seq)/增量/排除自己）、history/thread、server/channel-members、
// reactions、search、upload（MIME 白名单）。
//
// 注意：本文件自建 agent/频道/消息，afterAll 先清自有 attachments 再走通用 cleanup。

const CH = "zz_msg_" + uniqHandle().slice(-12);
const CH_PRIV = "zz_msgp_" + uniqHandle().slice(-12);

let owner: TestUser, intruder: TestUser;
let agentId = "";
let agentServerId = ""; // 频道所在 server（O3：human 侧显式租户头）
let machineToken = "";

async function mkAgent(user: TestUser): Promise<{ id: string; server_id: string }> {
  const r = await api("/api/agents", {
    method: "POST",
    cookie: user.cookie,
    csrf: user.csrf,
    body: { name: "msg_" + uniqHandle(), displayName: "MsgTest" },
  });
  expect(r.status).toBe(200);
  return r.data.agent;
}

afterAll(async () => {
  // attachments 无 FK 级联（uploader_id 裸列），测试内上传的行显式清掉
  await sql`DELETE FROM attachments WHERE filename LIKE 'zz-msg-%'`;
  await cleanupTestData();
  await closeSql();
});

describe("agent 消息面：send + requireOwnAgent 越权矩阵", () => {
  beforeAll(async () => {
    owner = await registerUser();
    intruder = await registerUser();
    const ag = await mkAgent(owner);
    agentId = ag.id;
    agentServerId = ag.server_id;

    // 公开频道（建在 agent 所属 server）+ agent 入圈
    const ch = await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: CH, type: "public", serverId: ag.server_id },
    });
    expect(ch.status).toBe(200);
    const j = await api(`/internal/agent/${agentId}/channels/${CH}/join`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(j.status).toBe(200);

    // 私有频道（agent 不入圈）——验证 send 的 no access 分支
    const priv = await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: CH_PRIV, type: "private", serverId: ag.server_id },
    });
    expect(priv.status).toBe(200);

    const mt = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: {},
    });
    expect(mt.status).toBe(200);
    machineToken = mt.data.token;
  });

  it("send 到公开频道 → sent，消息进 history（owner 视角可见 agent 消息）", async () => {
    const r = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: "hello-from-agent" },
    });
    expect(r.status).toBe(200);
    expect(r.data.state).toBe("sent");
    expect(r.data.channelId).toBeUndefined(); // 频道消息不回 channelId（DM 才回）
    expect(Number(r.data.messageSeq)).toBeGreaterThan(0); // messages.seq BIGINT → JSON string

    const hist = await api(`/api/messages/history?channel=${encodeURIComponent("#" + CH)}`, {
      cookie: owner.cookie,
      headers: { "x-server-id": agentServerId }, // 频道在个人 server，显式租户声明（O3）
    });
    expect(hist.status).toBe(200);
    const row = hist.data.messages.find((m: any) => m.id === r.data.messageId);
    expect(row).toBeTruthy();
    expect(row.content).toBe("hello-from-agent");
    expect(row.senderType).toBe("agent");
  });

  it("Bearer sk_machine_ 认证同路径可用（daemon 守护进程实际形态）", async () => {
    const r = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      token: machineToken,
      body: { target: `#${CH}`, content: "via-machine-token" },
    });
    expect(r.status).toBe(200);
    expect(r.data.state).toBe("sent");
  });

  it("400 缺 target / 404 未知频道 / 403 未入圈私有频道", async () => {
    expect(
      (
        await api(`/internal/agent/${agentId}/send`, {
          method: "POST",
          cookie: owner.cookie,
          csrf: owner.csrf,
          body: { content: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(`/internal/agent/${agentId}/send`, {
          method: "POST",
          cookie: owner.cookie,
          csrf: owner.csrf,
          body: { target: "#zz_no_such_channel_xyz", content: "x" },
        })
      ).status,
    ).toBe(404);
    const priv = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH_PRIV}`, content: "x" },
    });
    expect(priv.status).toBe(403);
    expect(priv.data.error).toBe("no access");
  });

  it("requireOwnAgent 403/404 矩阵：他人 cookie 用我的 agentId → 403 not your agent；不存在 → 404", async () => {
    // send 面
    const s403 = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: intruder.cookie,
      csrf: intruder.csrf,
      body: { target: `#${CH}`, content: "intruding" },
    });
    expect(s403.status).toBe(403);
    expect(s403.data.error).toBe("not your agent");
    const s404 = await api("/internal/agent/00000000-0000-0000-0000-000000000000/send", {
      method: "POST",
      cookie: intruder.cookie,
      csrf: intruder.csrf,
      body: { target: `#${CH}`, content: "x" },
    });
    expect(s404.status).toBe(404);
    expect(s404.data.error).toBe("agent not found");
    // history / receive / server / channel-members 面同样拦
    for (const path of [`history?channel=${CH}`, "receive", "server", `channel-members?channel=${CH}`]) {
      const r403 = await api(`/internal/agent/${agentId}/${path}`, { cookie: intruder.cookie });
      expect([403, 404]).toContain(r403.status);
      if (r403.status === 403) expect(r403.data.error).toBe("not your agent");
    }
    // intruder 自己的 agent 上同路径 → 200（403 只拦「别人的 agent」）
    const mine = await mkAgent(intruder);
    const own = await api(`/internal/agent/${mine.id}/history?channel=${CH}`, { cookie: intruder.cookie });
    expect(own.status).toBe(200);
  });

  it("sk_agent_ scoped token：mint 后可发消息（agent 子进程实际形态），用后撤销", async () => {
    const mint = await api(`/internal/agent/${agentId}/credentials`, { method: "POST", token: machineToken, body: {} });
    expect(mint.status).toBe(200);
    expect(mint.data.token).toMatch(/^sk_agent_/);
    const r = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      token: mint.data.token,
      body: { target: `#${CH}`, content: "via-scoped-token" },
    });
    expect(r.status).toBe(200);
    expect(r.data.state).toBe("sent");
    // 用完即撤，避免影响 credentials 文件的「签发→使用→吊销」全链断言
    const rev = await api(`/internal/agent/${agentId}/credentials`, { method: "DELETE", token: machineToken });
    expect(rev.status).toBe(200);
  });
});

describe("agent 消息面：edit / delete / thread", () => {
  let ownMsgId = "";
  let humanMsgId = "";

  beforeAll(async () => {
    const sent = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: "to-be-edited" },
    });
    ownMsgId = sent.data.messageId;
    const human = await api("/api/messages/send", {
      method: "POST",
      cookie: owner.cookie,
      headers: { "x-server-id": agentServerId },
      body: { target: `#${CH}`, content: "human-original" },
    });
    humanMsgId = human.data.messageId;
  });

  it("PUT 编辑自己 agent 消息 → 200 + editedAt；编辑人类消息 → 403；不存在 → 404", async () => {
    const ok = await api(`/internal/agent/${agentId}/messages/${ownMsgId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { content: "edited-by-agent" },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.message.content).toBe("edited-by-agent");
    expect(ok.data.message.editedAt).toBeTruthy();

    const human = await api(`/internal/agent/${agentId}/messages/${humanMsgId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { content: "hijack" },
    });
    expect(human.status).toBe(403);

    const missing = await api(`/internal/agent/${agentId}/messages/00000000-0000-0000-0000-000000000000`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { content: "x" },
    });
    expect(missing.status).toBe(404);
  });

  it("DELETE 无回复消息 → 硬删（库内行消失）", async () => {
    const sent = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: "to-be-deleted" },
    });
    const id = sent.data.messageId;
    const del = await api(`/internal/agent/${agentId}/messages/${id}`, {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);
    const rows = await sql`SELECT 1 FROM messages WHERE id = ${id}`;
    expect(rows.length).toBe(0);
  });

  it("DELETE 有线程回复的消息 → 软删（content 清空，行保留）", async () => {
    // 给 ownMsgId 发一条线程回复（人类侧 threadId）
    const reply = await api("/api/messages/send", {
      method: "POST",
      cookie: owner.cookie,
      headers: { "x-server-id": agentServerId },
      body: { target: `#${CH}`, content: "thread-reply", threadId: ownMsgId },
    });
    expect(reply.status).toBe(200);
    const del = await api(`/internal/agent/${agentId}/messages/${ownMsgId}`, {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(del.status).toBe(200);
    const rows = await sql<{ content: string }[]>`SELECT content FROM messages WHERE id = ${ownMsgId}`;
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("");
  });

  it("history?threadId= 按消息 id 前缀取线程", async () => {
    const prefix = ownMsgId.slice(0, 8);
    const r = await api(`/internal/agent/${agentId}/history?channel=${CH}&threadId=${prefix}`, {
      cookie: owner.cookie,
    });
    expect(r.status).toBe(200);
    const ids = r.data.messages.map((m: any) => m.id);
    expect(ids).toContain(ownMsgId);
    expect(ids.length).toBeGreaterThanOrEqual(2); // 父 + 回复
  });
});

describe("agent 消息面：receive 游标语义", () => {
  it("首次 receive 置 last_seen_seq=MAX(seq) 返回空；此后只回增量且排除自己", async () => {
    // 先确保有历史消息（前两个 describe 已发多条）
    const first = await api(`/internal/agent/${agentId}/receive`, { cookie: owner.cookie });
    expect(first.status).toBe(200);
    expect(first.data.messages).toEqual([]); // 首置 MAX(seq)：历史全跳过

    // 人类发新消息 → receive 拿到；agent 自己发的消息被排除
    await api("/api/messages/send", {
      method: "POST",
      cookie: owner.cookie,
      headers: { "x-server-id": agentServerId },
      body: { target: `#${CH}`, content: "recv-marker-" + Date.now() },
    });
    await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: "agent-own-should-skip" },
    });
    const second = await api(`/internal/agent/${agentId}/receive`, { cookie: owner.cookie });
    expect(second.status).toBe(200);
    const contents = second.data.messages.map((m: any) => m.content);
    expect(contents.some((c: string) => c.startsWith("recv-marker-"))).toBe(true);
    expect(contents).not.toContain("agent-own-should-skip");

    // 无新消息 → 空
    const third = await api(`/internal/agent/${agentId}/receive`, { cookie: owner.cookie });
    expect(third.data.messages).toEqual([]);
  });
});

describe("agent 消息面：server / channel-members / reactions / search", () => {
  it("GET server → 频道列表含已 join 频道（joined=true），未入圈私有频道不可见", async () => {
    const r = await api(`/internal/agent/${agentId}/server`, { cookie: owner.cookie });
    expect(r.status).toBe(200);
    const row = r.data.channels.find((c: any) => c.name === CH);
    expect(row?.joined).toBe(true);
    expect(r.data.channels.find((c: any) => c.name === CH_PRIV)).toBeUndefined();
    expect(r.data.humans.length).toBeGreaterThan(0);
  });

  it("GET channel-members → 含 agent 与 owner 人类成员", async () => {
    const r = await api(`/internal/agent/${agentId}/channel-members?channel=${CH}`, { cookie: owner.cookie });
    expect(r.status).toBe(200);
    const types = r.data.members.map((m: any) => m.member_type);
    expect(types).toContain("agent");
    expect(types).toContain("human");
  });

  it("reactions：添加 + 撤销（库内实查）", async () => {
    const sent = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: "react-target" },
    });
    const mid = sent.data.messageId;
    const add = await api(`/internal/agent/${agentId}/messages/${mid}/reactions`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { emoji: "🎯" },
    });
    expect(add.status).toBe(200);
    const rows = await sql`SELECT 1 FROM message_reactions WHERE message_id = ${mid} AND emoji = ${"🎯"}`;
    expect(rows.length).toBe(1);
    const del = await api(`/internal/agent/${agentId}/messages/${mid}/reactions`, {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { emoji: "🎯" },
    });
    expect(del.status).toBe(200);
    const after = await sql`SELECT 1 FROM message_reactions WHERE message_id = ${mid} AND emoji = ${"🎯"}`;
    expect(after.length).toBe(0);
  });

  it("search：命中 agent 消息；未知频道 404", async () => {
    const marker = "zzsearch" + Date.now().toString(36);
    await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: `findme ${marker}` },
    });
    const r = await api(`/internal/agent/${agentId}/search?q=${marker}&channel=${CH}`, { cookie: owner.cookie });
    expect(r.status).toBe(200);
    expect(r.data.results.some((m: any) => m.content.includes(marker))).toBe(true);
    const nf = await api(`/internal/agent/${agentId}/search?q=x&channel=zz_no_such_ch`, { cookie: owner.cookie });
    expect(nf.status).toBe(404);
  });
});

describe("agent 消息面：upload", () => {
  it("multipart text/plain 上传 → attachmentId + 大小；非白名单 MIME → 415", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["hello upload"], { type: "text/plain" }), "zz-msg-a.txt");
    const ok = await fetch(`http://localhost:3001/internal/agent/${agentId}/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${machineToken}` },
      body: fd,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { attachmentId: string; filename: string; sizeBytes: string };
    expect(body.attachmentId).toMatch(/^[0-9a-f-]{36}$/); // attachments.id 是 UUID
    expect(Number(body.sizeBytes)).toBe("hello upload".length); // size_bytes BIGINT → JSON string
    expect(body.filename).toBe("zz-msg-a.txt");

    const bad = new FormData();
    bad.append("file", new Blob(["\x00\x01"], { type: "application/octet-stream" }), "zz-msg-b.bin");
    const rejected = await fetch(`http://localhost:3001/internal/agent/${agentId}/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${machineToken}` },
      body: bad,
    });
    expect(rejected.status).toBe(415);
  });
});

describe("P1.33: agent 侧 threadId 校验 / content 上限 / 移出私有频道后禁改删", () => {
  it("send 显式 threadId：非 UUID / 不存在 / 跨频道 400，本频道合法 200", async () => {
    const parent = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: "thread-parent" },
    });
    expect(parent.status).toBe(200);
    const pid = parent.data.messageId as string;
    const send = (threadId: string, target = `#${CH}`) =>
      api(`/internal/agent/${agentId}/send`, {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrf,
        body: { target, content: "r", threadId },
      });
    expect((await send("not-a-uuid")).status).toBe(400);
    expect((await send("00000000-0000-0000-0000-000000000000")).status).toBe(400);
    // 跨频道：另建 agent 已入圈的公开频道，拿 CH 的父消息去那边回
    const CH2 = "zz_msg2_" + uniqHandle().slice(-12);
    await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name: CH2, serverId: agentServerId },
    });
    await api(`/internal/agent/${agentId}/channels/${CH2}/join`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect((await send(pid, `#${CH2}`)).status).toBe(400);
    expect((await send(pid)).status).toBe(200);
  });

  it("send / edit content 超长 400", async () => {
    const over = "x".repeat(10_001);
    expect(
      (
        await api(`/internal/agent/${agentId}/send`, {
          method: "POST",
          cookie: owner.cookie,
          csrf: owner.csrf,
          body: { target: `#${CH}`, content: over },
        })
      ).status,
    ).toBe(400);
    const s = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${CH}`, content: "cap-ok" },
    });
    expect(
      (
        await api(`/internal/agent/${agentId}/messages/${s.data.messageId}`, {
          method: "PUT",
          cookie: owner.cookie,
          csrf: owner.csrf,
          body: { content: over },
        })
      ).status,
    ).toBe(400);
  });

  it("agent 被移出私有频道后不得编辑/删除自己的旧消息", async () => {
    // owner 建私有频道并邀请 agent 入圈（邀请按 agent 名查找）
    const PRIV2 = "zz_msgk_" + uniqHandle().slice(-12);
    const ch = (
      await api("/api/channels", {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrf,
        body: { name: PRIV2, type: "private", serverId: agentServerId },
      })
    ).data.channel;
    const agName = (await sql<{ name: string }[]>`SELECT name FROM agents WHERE id = ${agentId}`)[0].name;
    expect(
      (
        await api(`/api/channels/${ch.id}/invite`, {
          method: "POST",
          cookie: owner.cookie,
          csrf: owner.csrf,
          body: { handle: agName },
        })
      ).status,
    ).toBe(200);
    // agent 在私有频道发一条（成员身份，可发）
    const s = await api(`/internal/agent/${agentId}/send`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { target: `#${PRIV2}`, content: "priv-msg" },
    });
    expect(s.status).toBe(200);
    // owner 把 agent 移出
    expect(
      (
        await api(`/api/channels/${ch.id}/members/${agentId}`, {
          method: "DELETE",
          cookie: owner.cookie,
          csrf: owner.csrf,
        })
      ).status,
    ).toBe(200);
    // 移出后：agent 改/删自己的旧消息均 403（此前只查 sender 归属）
    expect(
      (
        await api(`/internal/agent/${agentId}/messages/${s.data.messageId}`, {
          method: "PUT",
          cookie: owner.cookie,
          csrf: owner.csrf,
          body: { content: "x" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(`/internal/agent/${agentId}/messages/${s.data.messageId}`, {
          method: "DELETE",
          cookie: owner.cookie,
          csrf: owner.csrf,
        })
      ).status,
    ).toBe(403);
  });
});
