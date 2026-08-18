import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, type TestUser } from "./helpers.js";

/**
 * O2 审计 API 回归测试（黑盒，跑在 CI L3 真 PG 上）。
 *
 * 重点覆盖 2026-08-16 集成验证发现的回归：appendEvent 曾把 payload 用
 * JSON.stringify 传成字符串，导致 jsonb 双重编码、verify 误报哈希链断裂。
 * 本测试端到端断言 send→edit→delete 三事件链 verify 为 valid:true。
 */
describe("audit API（O2 哈希链端到端）", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await registerUser();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("消息 send→edit→delete 生成连续审计事件，链校验 valid", async () => {
    // 解析/创建 #general 频道
    const ch = await api("/api/channels/resolve?target=" + encodeURIComponent("#general"), {
      cookie: user.cookie,
    });
    if (ch.status !== 200) {
      await api("/api/channels", { method: "POST", cookie: user.cookie, csrf: user.csrf, body: { name: "general" } });
    }

    const s = await api("/api/messages/send", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      body: { target: "#general", content: "audit-probe" },
    });
    expect(s.status).toBe(200);
    const messageId = s.data.messageId as string;

    const e = await api(`/api/messages/${messageId}`, {
      method: "PUT",
      cookie: user.cookie,
      csrf: user.csrf,
      body: { content: "audit-probe-edited" },
    });
    expect(e.status).toBe(200);

    const d = await api(`/api/messages/${messageId}`, { method: "DELETE", cookie: user.cookie, csrf: user.csrf });
    expect(d.status).toBe(200);

    // 事件流水：send / edit / delete 至少 3 条，按时间序
    const audit = await api(`/api/audit?object_type=message&object_id=${messageId}`, { cookie: user.cookie });
    expect(audit.status).toBe(200);
    expect(audit.data.count).toBeGreaterThanOrEqual(3);
    const verbs = (audit.data.events as Array<{ verb: string }>).map((ev) => ev.verb);
    expect(verbs).toContain("message.send");
    expect(verbs).toContain("message.edit");
    expect(verbs).toContain("message.delete");

    // 哈希链校验必须通过（回归点：payload 双重编码会导致这里 valid=false）
    const verify = await api(`/api/audit/verify?object_type=message&object_id=${messageId}`, {
      cookie: user.cookie,
    });
    expect(verify.status).toBe(200);
    expect(verify.data.valid).toBe(true);
    expect(verify.data.count).toBe(audit.data.count);
  });

  it("未认证访问审计接口 401", async () => {
    const r = await api("/api/audit?object_type=message&object_id=00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(401);
  });
});
