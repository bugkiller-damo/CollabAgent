import { describe, it, expect, afterAll } from "vitest";
import { api, sql, closeSql } from "./helpers.js";

afterAll(async () => {
  await closeSql();
});

describe("metrics persistence", () => {
  it("GET /api/metrics/history returns array (possibly empty)", async () => {
    const r = await api("/api/metrics/history?range=1h");
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

    const r = await api("/api/metrics/history?range=1h");
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
    const r = await api("/api/metrics");
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("uptimeSec");
    expect(r.data.counters).toHaveProperty("messagesSent");
    expect(r.data.online).toHaveProperty("daemons");
  });
});
