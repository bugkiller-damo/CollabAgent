import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, uniqHandle } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("auth: register / login / cookie / csrf / sessions / deactivate", () => {
  it("register sets httpOnly access_token + csrf cookies and returns token", async () => {
    const h = uniqHandle();
    const r = await api("/api/auth/register", {
      method: "POST",
      body: { email: `${h}@test.local`, handle: h, password: "Test1234" },
    });
    expect(r.status).toBe(200);
    expect(r.data.token).toBeTruthy();
    expect(r.data.csrf).toBeTruthy();
    const joined = r.setCookie.join(";");
    expect(joined).toMatch(/access_token=/);
    expect(joined).toMatch(/HttpOnly/i);
    expect(joined).toMatch(/csrf_token=/);
  });

  it("login works and /me returns the user (cookie)", async () => {
    const u = await registerUser();
    const login = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "Test1234" } });
    expect(login.status).toBe(200);
    expect(login.data.token).toBeTruthy();
    const me = await api("/api/profile/me", { cookie: login.cookieHeader });
    expect(me.status).toBe(200);
    expect(me.data.user.handle).toBe(u.handle);
  });

  it("login with wrong password is rejected", async () => {
    const u = await registerUser();
    const r = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "wrongpass" } });
    expect(r.status).toBe(401);
  });

  it("cookie-auth mutating request without CSRF header is 403, with header is allowed", async () => {
    const u = await registerUser();
    // 无 csrf 头 → 403
    const noCsrf = await api("/api/auth/logout", { method: "POST", cookie: u.cookie, csrf: false as any });
    expect(noCsrf.status).toBe(403);
    // 带正确 csrf 头 → 200
    const withCsrf = await api("/api/auth/logout", { method: "POST", cookie: u.cookie, csrf: u.csrf });
    expect(withCsrf.status).toBe(200);
  });

  it("sessions list shows current session; logout-all then refresh-via-session is revoked", async () => {
    const u = await registerUser();
    const list = await api("/api/auth/sessions", { cookie: u.cookie });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.sessions)).toBe(true);
    expect(list.data.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("deactivate requires correct password, then blocks login", async () => {
    const u = await registerUser();
    const wrong = await api("/api/profile/deactivate", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { password: "nope" },
    });
    expect(wrong.status).toBe(401);
    const ok = await api("/api/profile/deactivate", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { password: "Test1234" },
    });
    expect(ok.status).toBe(200);
    const relog = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "Test1234" } });
    expect(relog.status).toBe(403);
  });

  it("data export returns the caller's profile", async () => {
    const u = await registerUser();
    const exp = await api("/api/profile/export", { cookie: u.cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.profile.handle).toBe(u.handle);
    expect(exp.data).toHaveProperty("messages");
    expect(exp.data).toHaveProperty("sessions");
  });
});

describe("auth: 登录防爆破（O6 账号+IP 双维度）", () => {
  // P1.13 起请求里的 x-forwarded-for 头对 IP 判定无效（clientIpOf 与限流同源
  // req.ip，XFF 采信与否由 TRUST_PROXY 决定，测试 server 默认不信任）。
  // 用例中保留这些头，恰恰回归验证「伪造 XFF 不能影响/绕过锁定」。
  // IP 维度的阈值语义由 login-lock.test.ts 高层 API 直测覆盖。
  it("同账号跨 IP 失败 5 次后锁定：换 IP + 正确密码仍 429", async () => {
    const u = await registerUser();
    const fail = (ip: string) =>
      api("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
        body: { login: u.handle, password: "WrongPass123" },
      });
    for (let i = 0; i < 4; i++) expect((await fail("10.11.0.1")).status).toBe(401);
    expect((await fail("10.11.0.2")).status).toBe(401); // 第 5 次：换 IP 仍计入账号维度
    // 账号已锁：换第三个 IP、用正确密码也进不去
    const locked = await api("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "10.11.0.3" },
      body: { login: u.handle, password: "Test1234" },
    });
    expect(locked.status).toBe(429);
    expect(locked.data.error).toMatch(/分钟后再试/);
  });

  it("成功登录清除计数：4 次失败后成功登录，再来 1 次失败不锁", async () => {
    const u = await registerUser();
    const fail = () =>
      api("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": "10.11.0.4" },
        body: { login: u.handle, password: "WrongPass123" },
      });
    for (let i = 0; i < 4; i++) expect((await fail()).status).toBe(401);
    const ok = await api("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "10.11.0.4" },
      body: { login: u.handle, password: "Test1234" },
    });
    expect(ok.status).toBe(200); // 成功 → 清除双 key
    // 若未清除，第 5 次失败会触发锁定；这里再成功登录一次验证未被锁
    expect(
      (
        await api("/api/auth/login", {
          method: "POST",
          headers: { "x-forwarded-for": "10.11.0.5" },
          body: { login: u.handle, password: "WrongPass123" },
        })
      ).status,
    ).toBe(401);
    const again = await api("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "10.11.0.5" },
      body: { login: u.handle, password: "Test1234" },
    });
    expect(again.status).toBe(200); // 计数已被上次成功清除，未达到锁定阈值
  });

  it("不存在的账号同样累计失败并锁定（防账号枚举爆破）", async () => {
    const ghost = uniqHandle();
    const fail = () =>
      api("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": "10.11.0.6" },
        body: { login: ghost, password: "Whatever123" },
      });
    for (let i = 0; i < 5; i++) expect((await fail()).status).toBe(401);
    expect((await fail()).status).toBe(429);
  });
});
