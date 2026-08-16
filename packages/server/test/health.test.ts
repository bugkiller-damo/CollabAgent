import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, registerUser, type TestUser } from "./helpers.js";

let user: TestUser;

beforeAll(async () => {
  user = await registerUser();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("health & metrics", () => {
  it("GET /api/health returns ok", async () => {
    const r = await api("/api/health");
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("ok");
  });

  it("GET /api/metrics requires auth", async () => {
    const r = await api("/api/metrics");
    expect(r.status).toBe(401);
  });

  it("GET /api/metrics exposes counters and online gauges", async () => {
    const r = await api("/api/metrics", { cookie: user.cookie });
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty("uptimeSec");
    expect(r.data.counters).toHaveProperty("messagesSent");
    expect(r.data.counters).toHaveProperty("remindersFired");
    expect(r.data.online).toHaveProperty("daemons");
    expect(r.data.online).toHaveProperty("agents");
  });
});
