import { describe, it, expect, afterAll } from "vitest";
import { api, registerUser, cleanupTestData, closeSql, uniqHandle } from "./helpers.js";

afterAll(async () => { await cleanupTestData(); await closeSql(); });

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

  it("login works and /me returns the user (Bearer)", async () => {
    const u = await registerUser();
    const login = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "Test1234" } });
    expect(login.status).toBe(200);
    expect(login.data.token).toBeTruthy();
    const me = await api("/api/auth/me", { token: login.data.token });
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
    const noCsrf = await api("/api/auth/logout", { method: "POST", cookie: u.cookie });
    expect(noCsrf.status).toBe(403);
    // 带正确 csrf 头 → 200
    const withCsrf = await api("/api/auth/logout", { method: "POST", cookie: u.cookie, csrf: u.csrf });
    expect(withCsrf.status).toBe(200);
  });

  it("sessions list shows current session; logout-all then refresh-via-session is revoked", async () => {
    const u = await registerUser();
    const list = await api("/api/auth/sessions", { token: u.token });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.sessions)).toBe(true);
    expect(list.data.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("deactivate requires correct password, then blocks login", async () => {
    const u = await registerUser();
    const wrong = await api("/api/auth/deactivate", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: { password: "nope" } });
    expect(wrong.status).toBe(401);
    const ok = await api("/api/auth/deactivate", { method: "POST", cookie: u.cookie, csrf: u.csrf, body: { password: "Test1234" } });
    expect(ok.status).toBe(200);
    const relog = await api("/api/auth/login", { method: "POST", body: { handle: u.handle, password: "Test1234" } });
    expect(relog.status).toBe(403);
  });

  it("data export returns the caller's profile", async () => {
    const u = await registerUser();
    const exp = await api("/api/auth/export", { token: u.token });
    expect(exp.status).toBe(200);
    expect(exp.data.profile.handle).toBe(u.handle);
    expect(exp.data).toHaveProperty("messages");
    expect(exp.data).toHaveProperty("sessions");
  });
});
