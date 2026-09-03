import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceId, metricsSnapshot, restoreCounters } from "../src/lib/metrics.js";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

/** restoreCounters 只认 { query } 形状——对齐 db/connection pgPlugin 的 { rows } 包装 */
const pgLike = {
  query: async (text: string, params?: unknown[]) => ({ rows: await sql.unsafe(text, params as unknown[]) }),
};

let user: TestUser;

beforeAll(async () => {
  user = await registerUser();
});

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("metrics persistence", () => {
  it("GET /api/metrics/history returns array (possibly empty)", async () => {
    const r = await api("/api/metrics/history?range=1h", { cookie: user.cookie });
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("samples");
    expect(Array.isArray(r.data.samples)).toBe(true);
  });

  it("GET /api/metrics/history returns persisted samples after insert", async () => {
    // 直接写入一条模拟采样数据
    await sql`
      INSERT INTO metrics_samples (sampled_at, messages_sent, dm_sent, reminders_fired, errors, logins,
        rss_mb, heap_used_mb, heap_total_mb, daemon_count, agent_total, agent_online)
      VALUES (now(), 100, 20, 5, 2, 10, 256, 512, 1024, 3, 15, 12)
    `;

    const r = await api("/api/metrics/history?range=1h", { cookie: user.cookie });
    expect(r.status).toBe(200);
    expect(r.data.samples.length).toBeGreaterThanOrEqual(1);

    // 验证最新一条包含我们写入的数据
    const last = r.data.samples[r.data.samples.length - 1];
    expect(Number(last.messages_sent)).toBe(100);
    expect(Number(last.dm_sent)).toBe(20);
    expect(Number(last.daemon_count)).toBe(3);
    expect(Number(last.agent_total)).toBe(15);
    expect(Number(last.agent_online)).toBe(12);
  });

  it("GET /api/metrics still works alongside history", async () => {
    const r = await api("/api/metrics", { cookie: user.cookie });
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("uptimeSec");
    expect(r.data.counters).toHaveProperty("messagesSent");
    expect(r.data.online).toHaveProperty("daemons");
  });

  it("GET /api/metrics requires auth (401 unauthenticated)", async () => {
    const r = await api("/api/metrics");
    expect(r.status).toBe(401);
    const h = await api("/api/metrics/history?range=1h");
    expect(h.status).toBe(401);
  });

  it("GET /api/metrics exposes cross-instance online counts + local detail (P1.27)", async () => {
    const r = await api("/api/metrics", { cookie: user.cookie });
    expect(r.status).toBe(200);
    expect(r.data.online).toHaveProperty("daemonsLocal");
    expect(r.data.online).toHaveProperty("daemons");
  });

  it("GET /api/metrics/history rows carry instance tag (P1.27)", async () => {
    await sql`
      INSERT INTO metrics_samples (sampled_at, messages_sent, dm_sent, reminders_fired, errors, logins,
        rss_mb, heap_used_mb, heap_total_mb, daemon_count, agent_total, agent_online, instance)
      VALUES (now(), 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 'zz_m_inst')
    `;
    const r = await api("/api/metrics/history?range=1h", { cookie: user.cookie });
    expect(r.status).toBe(200);
    const mine = r.data.samples.find((s: Record<string, unknown>) => s.instance === "zz_m_inst");
    expect(mine).toBeDefined();
  });
});

describe("restoreCounters (P1.27 全量恢复)", () => {
  it("按本实例最新行恢复全部 12 个计数器", async () => {
    const inst = `zz_m_${Date.now().toString(36)}`;
    await sql`
      INSERT INTO metrics_samples (sampled_at, instance,
        messages_sent, dm_sent, reminders_fired, errors, logins,
        patrol_posted, patrol_silent, patrol_auto_paused,
        machine_auth_bcrypt_scans, machine_auth_bcrypt_hits, machine_auth_bcrypt_rejected,
        ws_slow_consumer_terminated)
      VALUES (now(), ${inst}, 111, 22, 33, 13, 14, 44, 55, 66, 77, 88, 99, 12)
    `;
    await restoreCounters(pgLike, inst);
    const c = metricsSnapshot().counters;
    expect(c.messagesSent).toBe(111);
    expect(c.dmSent).toBe(22);
    expect(c.remindersFired).toBe(33);
    expect(c.patrolPosted).toBe(44);
    expect(c.patrolSilent).toBe(55);
    expect(c.patrolAutoPaused).toBe(66);
    expect(c.machineAuthBcryptScans).toBe(77);
    expect(c.machineAuthBcryptHits).toBe(88);
    expect(c.machineAuthBcryptRejected).toBe(99);
    expect(c.wsSlowConsumerTerminated).toBe(12);
    expect(c.errors).toBe(13);
    expect(c.logins).toBe(14);
  });

  it("本实例无行时回退全表最新行（024 升级首启的 legacy 接续）", async () => {
    // future 时间戳保证该行是全表最新（测试 server 的 60s 采样 tick 不会插到它前面）
    await sql`
      INSERT INTO metrics_samples (sampled_at, instance, messages_sent)
      VALUES (now() + interval '10 seconds', 'zz_m_legacy', 777)
    `;
    await restoreCounters(pgLike, "zz_m_no_such_instance");
    expect(metricsSnapshot().counters.messagesSent).toBe(777);
    // 恢复后清掉测试行，避免残留影响 history 断言
    await sql`DELETE FROM metrics_samples WHERE instance IN ('zz_m_legacy', 'zz_m_inst')`;
  });

  it("instanceId() 有值（SLOCK_INSTANCE_ID 或主机名）", () => {
    expect(typeof instanceId()).toBe("string");
    expect(instanceId().length).toBeGreaterThan(0);
  });
});
