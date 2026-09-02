import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, sql, uniqHandle } from "./helpers.js";

// T2 patrol 路由集成测试(设计:docs/2026-08-19/02-t2-agent-patrol-design.md §5 L2)。
// 覆盖:patrol 创建校验(频率下限/非法语法/数量上限)、kind 分流、pause/resume、
// PATCH 校验、事件日志、非 owner 拒绝。
// 注意:scheduler tick 行为(沉默判定/自动暂停)依赖 daemon 连接,不在本测试面,
// 由手动 E2E 剧本覆盖(§5 L3)。
describe("patrol: agent 定时巡检路由", () => {
  let cookie: string, csrf: string;
  let agentId: string;
  const createdReminderIds: string[] = [];

  beforeAll(async () => {
    const u = await registerUser();
    cookie = u.cookie;
    csrf = u.csrf;
    const name = `pat${uniqHandle()
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(-20)}`;
    const r = await api("/api/agents", { method: "POST", cookie, body: { name, runtime: "claude", model: "sonnet" } });
    expect(r.status).toBe(200);
    agentId = r.data.agent.id;
  });

  afterAll(async () => {
    // helpers 的通用清理由 user 维度出发,reminders.owner_id 是 agent id,先显式清
    if (agentId) {
      await sql`DELETE FROM reminder_events WHERE reminder_id IN (SELECT id FROM reminders WHERE owner_id = ${agentId})`;
      await sql`DELETE FROM reminders WHERE owner_id = ${agentId}`;
    }
    await cleanupTestData();
    await closeSql();
  });

  const createPatrol = (body: Record<string, unknown>) =>
    api(`/internal/agent/${agentId}/reminders`, { method: "POST", cookie, csrf, body });

  it("创建 patrol:合法 every:10m + instructions → 200,DTO 带 kind/instructions", async () => {
    const r = await createPatrol({
      title: "告警巡检",
      instructions: "读 #alerts 汇总异常,无异常沉默",
      kind: "patrol",
      repeat: "every:10m",
      channel: "#alerts",
    });
    expect(r.status).toBe(200);
    expect(r.data.reminder.kind).toBe("patrol");
    expect(r.data.reminder.instructions).toContain("汇总异常");
    expect(r.data.reminder.paused).toBe(false);
    expect(r.data.reminder.maxConsecutiveSilent).toBe(5);
    createdReminderIds.push(r.data.reminder.id);
  });

  it("频率下限:every:30s → 400", async () => {
    const r = await createPatrol({ title: "太频繁", kind: "patrol", repeat: "every:30s" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/too short/);
  });

  it("非法语法:repeat 不可解析 → 400", async () => {
    const r = await createPatrol({ title: "坏规则", kind: "patrol", repeat: "whenever" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/unsupported/);
  });

  it("缺 title → 400(与 reminder 一致)", async () => {
    const r = await createPatrol({ kind: "patrol", repeat: "every:10m" });
    expect(r.status).toBe(400);
  });

  it("kind 分流:list?kind=patrol 只回 patrol,普通 reminder 不混入", async () => {
    const rem = await api(`/internal/agent/${agentId}/reminders`, {
      method: "POST",
      cookie,
      csrf,
      body: { title: "普通提醒", delaySeconds: 3600 },
    });
    expect(rem.status).toBe(200);
    createdReminderIds.push(rem.data.reminder.id);
    expect(rem.data.reminder.kind).toBe("reminder");

    const list = await api(`/internal/agent/${agentId}/reminders?kind=patrol&status=all`, { cookie });
    expect(list.status).toBe(200);
    expect(list.data.reminders.length).toBeGreaterThan(0);
    expect(list.data.reminders.every((x: any) => x.kind === "patrol")).toBe(true);
  });

  it("pause → paused=true 且有 paused 事件;resume → 重新排程 + 清零 + resumed 事件", async () => {
    const c = await createPatrol({ title: "启停验证", kind: "patrol", repeat: "every:10m", instructions: "x" });
    expect(c.status).toBe(200);
    const id = c.data.reminder.id;
    createdReminderIds.push(id);

    const p = await api(`/internal/agent/${agentId}/reminders/${id}/pause`, { method: "POST", cookie, csrf });
    expect(p.status).toBe(200);
    expect(p.data.reminder.paused).toBe(true);

    const r = await api(`/internal/agent/${agentId}/reminders/${id}/resume`, { method: "POST", cookie, csrf });
    expect(r.status).toBe(200);
    expect(r.data.reminder.paused).toBe(false);
    expect(r.data.reminder.consecutiveSilent).toBe(0);
    expect(r.data.reminder.status).toBe("scheduled");
    expect(new Date(r.data.reminder.fireAt).getTime()).toBeGreaterThan(Date.now());

    const log = await api(`/internal/agent/${agentId}/reminders/${id}/log`, { cookie });
    expect(log.status).toBe(200);
    const types = log.data.events.map((e: any) => e.event_type);
    expect(types).toContain("paused");
    expect(types).toContain("resumed");
  });

  it("PATCH:patrol 改 every:30s → 400;改 instructions → 200", async () => {
    const id = createdReminderIds[0];
    const bad = await api(`/internal/agent/${agentId}/reminders/${id}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { repeat: "every:30s" },
    });
    expect(bad.status).toBe(400);

    const ok = await api(`/internal/agent/${agentId}/reminders/${id}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { instructions: "新指令:每小时看一次任务板" },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.reminder.instructions).toContain("任务板");
  });

  it("数量上限:活跃 patrol 满 10 条后再建 → 400(后置,自建自清)", async () => {
    // 直接 SQL 补齐到上限(走 API 逐条建太慢);当前活跃 patrol 已有 2 条(首条+启停条)
    for (let i = 0; i < 8; i++) {
      await sql`
        INSERT INTO reminders (owner_id, title, fire_at, repeat_rule, status, kind)
        VALUES (${agentId}, ${"上限占位" + i}, now() + interval '1 hour', 'every:1h', 'scheduled', 'patrol')`;
    }
    const r = await createPatrol({ title: "超上限", kind: "patrol", repeat: "every:10m" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/too many active patrols/);
    await sql`DELETE FROM reminders WHERE owner_id = ${agentId} AND title LIKE '上限占位%'`;
  });

  it("非 owner 访问他人 agent 的 patrol → 403", async () => {
    const other = await registerUser();
    const r = await api(`/internal/agent/${agentId}/reminders?kind=patrol`, { cookie: other.cookie });
    expect(r.status).toBe(403);
  });

  // ---- P1.23：IANA 时区显式入库（daily@HH:MM 不再依赖 server 本地时区）----
  it("timezone:缺省落 server 本地 IANA;显式 Asia/Shanghai 入库并回显", async () => {
    const def = await createPatrol({ title: "默认tz", repeat: "every:10m" });
    expect(def.status).toBe(200);
    expect(typeof def.data.reminder.timezone).toBe("string");
    expect(def.data.reminder.timezone!.length).toBeGreaterThan(0);
    createdReminderIds.push(def.data.reminder.id);

    const sh = await createPatrol({ title: "上海tz", repeat: "daily@09:00", timezone: "Asia/Shanghai" });
    expect(sh.status).toBe(200);
    expect(sh.data.reminder.timezone).toBe("Asia/Shanghai");
    // daily@09:00（上海）的初始锚点必须是未来时刻
    expect(new Date(sh.data.reminder.fireAt).getTime()).toBeGreaterThan(Date.now());
    createdReminderIds.push(sh.data.reminder.id);
  });

  it("timezone:非法 IANA 名 → 400", async () => {
    const r = await createPatrol({ title: "坏tz", repeat: "every:10m", timezone: "Mars/Olympus" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/invalid timezone/);
  });

  it("timezone:PATCH 改合法 tz → 200 回显;改非法 → 400", async () => {
    const c = await createPatrol({ title: "patchtz", repeat: "every:10m" });
    expect(c.status).toBe(200);
    const id = c.data.reminder.id;
    createdReminderIds.push(id);
    const ok = await api(`/internal/agent/${agentId}/reminders/${id}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { timezone: "America/New_York" },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.reminder.timezone).toBe("America/New_York");
    const bad = await api(`/internal/agent/${agentId}/reminders/${id}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { timezone: "Nope/Nope" },
    });
    expect(bad.status).toBe(400);
  });
});
