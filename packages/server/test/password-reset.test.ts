import { afterAll, describe, expect, it } from "vitest";
import { generateResetCode, hashResetCode, RESET_CODE_TTL_MS, resetCodeMatches } from "../src/lib/password-reset.js";
import { api, cleanupTestData, closeSql, registerUser, sql } from "./helpers.js";

// P1.20：找回密码验证码纯函数（离线可测部分）
describe("password-reset 纯函数（P1.20）", () => {
  it("generateResetCode：恒为 6 位数字（拒绝采样路径多次抽样）", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateResetCode()).toMatch(/^\d{6}$/);
    }
  });

  it("hashResetCode：sha256 十六进制、确定性、不同码不同哈希", () => {
    const h1 = hashResetCode("123456");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetCode("123456")).toBe(h1);
    expect(hashResetCode("654321")).not.toBe(h1);
  });

  it("resetCodeMatches：正确码 true / 错误码 false / 长度不等安全返回 false", () => {
    const stored = hashResetCode("042913");
    expect(resetCodeMatches("042913", stored)).toBe(true);
    expect(resetCodeMatches("042914", stored)).toBe(false);
    expect(resetCodeMatches("04291", stored)).toBe(false);
    expect(resetCodeMatches("042913", "not-a-hash")).toBe(false);
  });

  it("TTL 常量 = 10 分钟", () => {
    expect(RESET_CODE_TTL_MS).toBe(10 * 60 * 1000);
  });
});

// 在线负路径：共享测试 server 不带 SLOCK_DEV_RESET_CODE（默认关闭态）——
// 关闭态语义即生产行为：诚实文案、不落状态、不假成功。
describe("password-reset 路由（默认关闭态，P1.20）", () => {
  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("forgot：恒 200 通用文案、无 devCode；已注册与未注册邮箱同形（无枚举）", async () => {
    const u = await registerUser();
    const a = await api("/api/auth/forgot-password", {
      method: "POST",
      body: { email: `${u.handle}@test.local` },
    });
    const b = await api("/api/auth/forgot-password", { method: "POST", body: { email: "ghost@test.local" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.data.devCode).toBeUndefined();
    expect(b.data.devCode).toBeUndefined();
    expect(a.data.message).toBe(b.data.message);
  });

  it("forgot：关闭态不落库——reset_code/reset_expires 保持 NULL（无假状态）", async () => {
    const u = await registerUser();
    await api("/api/auth/forgot-password", { method: "POST", body: { email: `${u.handle}@test.local` } });
    const r = await sql`SELECT reset_code, reset_expires FROM users WHERE id = ${u.userId}`;
    expect(r[0].reset_code).toBeNull();
    expect(r[0].reset_expires).toBeNull();
  });

  it("reset：关闭态 403 拒绝", async () => {
    const r = await api("/api/auth/reset-password", {
      method: "POST",
      body: { email: "x@test.local", code: "123456", password: "Test1234" },
    });
    expect(r.status).toBe(403);
  });

  it("CSRF 豁免：带 cookie 会话、无 csrf token 的 forgot 不被 403（豁免名单 forgot|reset 前缀生效）", async () => {
    const u = await registerUser();
    const r = await api("/api/auth/forgot-password", {
      method: "POST",
      body: { email: `${u.handle}@test.local` },
      cookie: u.cookie,
      csrf: null,
    });
    expect(r.status).toBe(200);
  });
});
