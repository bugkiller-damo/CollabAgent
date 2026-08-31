import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MACHINE_TOKEN_MAX_ACTIVE_PER_USER } from "../src/lib/machine-token-policy.js";
import { sha256Token } from "../src/lib/token-hash.js";
import { api, BASE, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

/**
 * 评估报告 P1.12：machine_tokens 默认过期（90 天滚动续期）+ 同用户签发数量上限。
 * 覆盖：签发带 90 天有效期、上限 409 与吊销释放、过期令牌 HTTP 401 / WS 4001、
 * HTTP 阈值续期（<30 天才写）、充裕期不写、WS 连接即续期、NULL expires_at 存量豁免。
 */

const DAY = 86_400_000;
const WS_BASE = BASE.replace(/^http/, "ws") + "/ws";

function remainingDays(expiresAt: Date | string): number {
  return (new Date(expiresAt).getTime() - Date.now()) / DAY;
}

async function mintToken(u: TestUser): Promise<string> {
  const r = await api("/api/profile/machine-token", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: {} });
  expect(r.status).toBe(200);
  return r.data.token as string;
}

async function rowByToken(token: string): Promise<{ id: string; expires_at: Date | null } | undefined> {
  const rows = await sql`SELECT id, expires_at FROM machine_tokens WHERE token_hash = ${sha256Token(token)}`;
  return rows[0] as { id: string; expires_at: Date | null } | undefined;
}

async function setExpiry(token: string, sqlInterval: string): Promise<void> {
  // sqlInterval 是代码内白名单字面量（测试文件内固定值），非用户输入
  await sql.unsafe(`UPDATE machine_tokens SET expires_at = now() + interval '${sqlInterval}' WHERE token_hash = $1`, [
    sha256Token(token),
  ]);
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS close timeout")), 25_000);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once("error", () => {
      /* close 事件仍会触发 */
    });
  });
}

function firstMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS message timeout")), 25_000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

describe("machine token 默认过期与签发上限（P1.12）", () => {
  let u: TestUser;

  beforeAll(async () => {
    u = await registerUser();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("POST /machine-token 签发即带 ~90 天有效期", async () => {
    const token = await mintToken(u);
    const row = await rowByToken(token);
    expect(row).toBeDefined();
    const days = remainingDays(row!.expires_at!);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90.01);
  });

  it("同用户活跃令牌达上限后签发 409，吊销一个后可再签", async () => {
    const u2 = await registerUser();
    for (let i = 0; i < MACHINE_TOKEN_MAX_ACTIVE_PER_USER; i++) {
      const r = await api("/api/profile/machine-token", {
        method: "POST",
        cookie: u2.cookie,
        csrf: u2.csrf,
        body: {},
      });
      expect(r.status).toBe(200);
    }
    const over = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: u2.cookie,
      csrf: u2.csrf,
      body: {},
    });
    expect(over.status).toBe(409);

    // 吊销一个 → 额度释放
    const list = await api("/api/profile/tokens", { cookie: u2.cookie });
    expect(list.status).toBe(200);
    const tokenId = list.data.tokens[0].id as string;
    const del = await api(`/api/profile/tokens/${tokenId}`, {
      method: "DELETE",
      cookie: u2.cookie,
      csrf: u2.csrf,
    });
    expect(del.status).toBe(200);
    const again = await api("/api/profile/machine-token", {
      method: "POST",
      cookie: u2.cookie,
      csrf: u2.csrf,
      body: {},
    });
    expect(again.status).toBe(200);
  });

  it("过期令牌 HTTP 认证 401", async () => {
    const token = await mintToken(u);
    await setExpiry(token, "1 hour ago");
    const r = await api("/api/profile/tokens", { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(401);
  });

  it("过期令牌 WS daemon 连接被 4001 关闭", { timeout: 30_000 }, async () => {
    const token = await mintToken(u);
    await setExpiry(token, "1 hour ago");
    const ws = new WebSocket(WS_BASE, { headers: { Authorization: `Bearer ${token}` } });
    expect(await closeCode(ws)).toBe(4001);
  });

  it("HTTP 滚动续期：剩余 <30 天时认证即顺延到 ~90 天", async () => {
    const token = await mintToken(u);
    await setExpiry(token, "10 days");
    const r = await api("/api/profile/tokens", { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const days = remainingDays((await rowByToken(token))!.expires_at!);
    expect(days).toBeGreaterThan(89);
  });

  it("HTTP 剩余有效期充裕（80 天）时不产生续期写", async () => {
    const token = await mintToken(u);
    await setExpiry(token, "80 days");
    const r = await api("/api/profile/tokens", { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const days = remainingDays((await rowByToken(token))!.expires_at!);
    expect(days).toBeGreaterThan(79);
    expect(days).toBeLessThan(81);
  });

  it("WS 连接即续期（daemon 主链路）", { timeout: 30_000 }, async () => {
    const token = await mintToken(u);
    await setExpiry(token, "10 days");
    const ws = new WebSocket(WS_BASE, { headers: { Authorization: `Bearer ${token}` } });
    const first = await firstMessage(ws);
    expect(first.type).toBe("connected");
    // 续期在 resolveUserId 内 await，先于 connected 帧送达，这里可确定性断言
    const days = remainingDays((await rowByToken(token))!.expires_at!);
    expect(days).toBeGreaterThan(89);
    ws.close();
  });

  it("NULL expires_at 存量行豁免：仍可认证且不被续期改写", async () => {
    const legacyToken = "sk_machine_" + randomBytes(24).toString("base64url");
    const server = await sql`SELECT id FROM servers WHERE personal = false ORDER BY created_at ASC LIMIT 1`;
    await sql`INSERT INTO machine_tokens (user_id, server_id, token_hash, token_prefix, scope, expires_at)
              VALUES (${u.userId}, ${String(server[0].id)}, ${sha256Token(legacyToken)}, 'sk_machine_',
                      ${sql.json({})}, NULL)`;
    const r = await api("/api/profile/tokens", { headers: { Authorization: `Bearer ${legacyToken}` } });
    expect(r.status).toBe(200);
    expect((await rowByToken(legacyToken))!.expires_at).toBeNull();
  });
});
