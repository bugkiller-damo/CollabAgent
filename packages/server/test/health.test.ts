import { describe, it, expect } from "vitest";
import { api } from "./helpers.js";

describe("health & metrics", () => {
  it("GET /api/health returns ok", async () => {
    const r = await api("/api/health");
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("ok");
  });

  it("GET /api/metrics exposes counters and online gauges", async () => {
    const r = await api("/api/metrics");
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("uptimeSec");
    expect(r.data.counters).toHaveProperty("messagesSent");
    expect(r.data.counters).toHaveProperty("remindersFired");
    expect(r.data.online).toHaveProperty("daemons");
    expect(r.data.online).toHaveProperty("agents");
  });
});
