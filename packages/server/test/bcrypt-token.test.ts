import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { api, BASE, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

/**
 * O8：bcrypt 兼容分支行为回归——旧格式令牌仍能通过 HTTP/WS 认证，
 * 且 metrics 计数器可观测（machineAuthBcryptScans/Hits）。
 * 注意：兼容分支是全表扫描 + 逐行 bcrypt.compare（O(N×100ms)），
 * dev 库里历史 bcrypt 行越多越慢，故给足超时。
 */

const WS_BASE = BASE.replace(/^http/, "ws") + "/ws";

describe("bcrypt 令牌兼容分支（O8 观测）", () => {
  let u: TestUser;
  let legacyToken: string;

  beforeAll(async () => {
    u = await registerUser();
    legacyToken = "sk_machine_" + randomBytes(16).toString("hex");
    // 模拟历史数据：bcrypt 哈希落库（低 cost 仅为测试速度；语义与存量 $2a$12$ 一致）
    const stored = bcrypt.hashSync(legacyToken, 4);
    const server = await sql`SELECT id FROM servers WHERE personal = false ORDER BY created_at ASC LIMIT 1`;
    const serverId = String(server[0].id);
    await sql`INSERT INTO machine_tokens (user_id, server_id, token_hash, token_prefix, scope)
              VALUES (${u.userId}, ${serverId}, ${stored}, 'sk_machine_', ${sql.json({})})`;
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("HTTP：旧 bcrypt 令牌经兼容分支认证成功", { timeout: 30_000 }, async () => {
    const r = await api("/api/profile/tokens", {
      headers: { Authorization: `Bearer ${legacyToken}` },
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.tokens)).toBe(true);
  });

  it("WS：旧 bcrypt 令牌的 daemon 连接认证成功", { timeout: 30_000 }, async () => {
    const ws = new WebSocket(WS_BASE, { headers: { Authorization: `Bearer ${legacyToken}` } });
    const first = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS timeout")), 25_000);
      ws.once("message", (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
      ws.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`WS closed ${code}`));
      });
    });
    expect(first.type).toBe("connected");
    expect(first).toHaveProperty("serverTime");
    ws.close();
  });

  it("metrics 可观测：scans/hits 计数器已增长", async () => {
    const r = await api("/api/metrics", { cookie: u.cookie });
    expect(r.status).toBe(200);
    const counters = r.data.counters as Record<string, number>;
    expect(counters.machineAuthBcryptScans).toBeGreaterThanOrEqual(1);
    expect(counters.machineAuthBcryptHits).toBeGreaterThanOrEqual(1);
  });
});
