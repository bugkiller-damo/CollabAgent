import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, makeOrgOwner, registerUser, sql, uniqHandle } from "./helpers.js";

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

  it("登录失败统一 401 通用文案：用户不存在与密码错误不可区分（P1.16）", async () => {
    const u = await registerUser();
    const wrong = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "wrongpass" } });
    const ghost = await api("/api/auth/login", {
      method: "POST",
      body: { handle: uniqHandle(), password: "Whatever123" },
    });
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(ghost.data.error).toBe(wrong.data.error);
    expect(wrong.data.error).toBe("用户名或密码错误");
  });

  it("已注销账号：错误密码按普通失败 401，正确密码才暴露 403（P1.16 挪序）", async () => {
    const u = await registerUser();
    const de = await api("/api/profile/deactivate", {
      method: "POST",
      cookie: u.cookie,
      csrf: u.csrf,
      body: { password: "Test1234" },
    });
    expect(de.status).toBe(200);
    const wrong = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "nope" } });
    expect(wrong.status).toBe(401);
    expect(wrong.data.error).toBe("用户名或密码错误");
    const right = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "Test1234" } });
    expect(right.status).toBe(403);
  });

  it("refresh 仅接受 body.refreshToken：cookie 兜底死码已删，缺参 400（P1.16）", async () => {
    const u = await registerUser();
    const r = await api("/api/auth/refresh", { method: "POST", cookie: u.cookie });
    expect(r.status).toBe(400);
  });

  it("refresh 轮换闭环：新 refresh 可继续轮换、旧 refresh 吊销 401、access 不可当 refresh 用（P1.16）", async () => {
    const h = uniqHandle();
    const reg = await api("/api/auth/register", {
      method: "POST",
      body: { email: `${h}@test.local`, handle: h, password: "Test1234" },
    });
    expect(reg.status).toBe(200);
    const refresh1 = reg.data.refreshToken as string;
    expect(refresh1).toBeTruthy();

    const r1 = await api("/api/auth/refresh", { method: "POST", body: { refreshToken: refresh1 } });
    expect(r1.status).toBe(200);
    expect(r1.data.refreshToken).toBeTruthy();
    expect(r1.data.refreshToken).not.toBe(refresh1);
    // 轮换出的新 refresh 仍可用
    const r2 = await api("/api/auth/refresh", { method: "POST", body: { refreshToken: r1.data.refreshToken } });
    expect(r2.status).toBe(200);
    // 旧 refresh 对应会话已吊销 → 401
    const r3 = await api("/api/auth/refresh", { method: "POST", body: { refreshToken: refresh1 } });
    expect(r3.status).toBe(401);
    // access token（JWT_SECRET）与 refresh（REFRESH_SECRET）不同 secret，不能互相顶替
    const asRefresh = await api("/api/auth/refresh", { method: "POST", body: { refreshToken: reg.data.token } });
    expect(asRefresh.status).toBe(401);
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

describe("auth: P1.31 register 加固（email 校验 / 23505→409 / invite 事务消费）", () => {
  const reg = (h: string, extra: Record<string, unknown> = {}) =>
    api("/api/auth/register", {
      method: "POST",
      body: { email: `${h}@test.local`, handle: h, password: "Test1234", ...extra },
    });
  const memberRole = async (orgId: string, userId: string) => {
    const rows = await sql`SELECT role FROM server_members WHERE server_id = ${orgId} AND user_id = ${userId}`;
    return rows[0]?.role as string | undefined;
  };
  const inviteUses = async (token: string) => {
    const rows = await sql`SELECT uses FROM invites WHERE token = ${token}`;
    return Number(rows[0].uses);
  };
  async function createInvite(maxUses: number | null, expiresInDays?: number) {
    const owner = await registerUser();
    const orgId = await makeOrgOwner(owner);
    const r = await api(`/api/orgs/${orgId}/invites`, {
      method: "POST",
      cookie: owner.cookie,
      body: { maxUses, expiresInDays },
    });
    expect(r.status).toBe(200);
    return { token: r.data.token as string, orgId, owner };
  }

  it("非法 email 400（P1.31 新增格式校验）", async () => {
    const r = await reg(uniqHandle(), { email: "not-an-email" });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("邮箱");
  });

  it("并发同名注册：恰一个 200、另一个 409（唯一约束兜底，无 500）", async () => {
    const h = uniqHandle();
    const [a, b] = await Promise.all([reg(h), reg(h)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("有效 invite：注册即入圈且 uses+1", async () => {
    const { token, orgId } = await createInvite(5);
    const r = await reg(uniqHandle(), { invite: token });
    expect(r.status).toBe(200);
    expect(await memberRole(orgId, r.data.user.id)).toBe("member");
    expect(await inviteUses(token)).toBe(1);
  });

  it("限额 1 的 invite 并发双注册：恰消费一次，两人均注册成功但仅一人入圈（TOCTOU 关闭）", async () => {
    const { token, orgId } = await createInvite(1);
    const [a, b] = await Promise.all([reg(uniqHandle(), { invite: token }), reg(uniqHandle(), { invite: token })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // 条件 UPDATE 行锁串行：后到者 WHERE uses < max_uses 不成立，0 行自然失效
    expect(await inviteUses(token)).toBe(1);
    const roles = [await memberRole(orgId, a.data.user.id), await memberRole(orgId, b.data.user.id)];
    expect(roles.filter(Boolean)).toHaveLength(1);
  });

  it("限额耗尽的 invite：后续注册成功但不入圈、不再消费", async () => {
    const { token, orgId } = await createInvite(1);
    await reg(uniqHandle(), { invite: token });
    const r2 = await reg(uniqHandle(), { invite: token });
    expect(r2.status).toBe(200);
    expect(await memberRole(orgId, r2.data.user.id)).toBeUndefined();
    expect(await inviteUses(token)).toBe(1);
  });

  it("过期 invite：注册成功但不入圈、不消费", async () => {
    const { token, orgId } = await createInvite(5, -1);
    const r = await reg(uniqHandle(), { invite: token });
    expect(r.status).toBe(200);
    expect(await memberRole(orgId, r.data.user.id)).toBeUndefined();
    expect(await inviteUses(token)).toBe(0);
  });

  it("已吊销 invite：注册成功但不入圈、不消费", async () => {
    const { token, orgId, owner } = await createInvite(5);
    const rev = await api(`/api/orgs/${orgId}/invites/${token}`, { method: "DELETE", cookie: owner.cookie });
    expect(rev.status).toBe(200);
    const r = await reg(uniqHandle(), { invite: token });
    expect(r.status).toBe(200);
    expect(await memberRole(orgId, r.data.user.id)).toBeUndefined();
    expect(await inviteUses(token)).toBe(0);
  });
});
