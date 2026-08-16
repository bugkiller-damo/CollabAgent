import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("notifications: 列表 / 已读 / 未读计数", () => {
  let ck: string, cs: string;

  beforeAll(async () => {
    const u = await registerUser();
    ck = u.cookie;
    cs = u.csrf;
  });

  it("返回列表和未读数", async () => {
    const r = await api("/api/notifications", { cookie: ck });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.notifications)).toBe(true);
    expect(typeof r.data.unreadCount).toBe("number");
  });

  it("字段完整", async () => {
    const r = await api("/api/notifications", { cookie: ck });
    if (r.data.notifications.length) {
      const n = r.data.notifications[0];
      expect(n).toHaveProperty("id");
      expect(n).toHaveProperty("type");
      expect(n).toHaveProperty("title");
      expect(n).toHaveProperty("read");
    }
  });

  it("unreadOnly 过滤", async () => {
    const r = await api("/api/notifications?unreadOnly=true", { cookie: ck });
    r.data.notifications.forEach((n: any) => {
      expect(n.read).toBe(false);
    });
  });

  it("标记单条已读", async () => {
    const list = await api("/api/notifications?unreadOnly=true", { cookie: ck });
    if (!list.data.notifications.length) return;
    expect(
      (await api(`/api/notifications/${list.data.notifications[0].id}/read`, { method: "PATCH", cookie: ck, csrf: cs }))
        .status,
    ).toBe(200);
  });

  it("不存在的通知 404", async () => {
    expect(
      (
        await api("/api/notifications/00000000-0000-0000-0000-000000000000/read", {
          method: "PATCH",
          cookie: ck,
          csrf: cs,
        })
      ).status,
    ).toBe(404);
  });

  it("批量标记已读", async () => {
    expect((await api("/api/notifications/read", { method: "PATCH", cookie: ck, csrf: cs, body: {} })).status).toBe(
      200,
    );
  });

  it("未读计数", async () => {
    const r = await api("/api/notifications/unread-count", { cookie: ck });
    expect(r.status).toBe(200);
    expect(typeof r.data.unreadCount).toBe("number");
  });
});
