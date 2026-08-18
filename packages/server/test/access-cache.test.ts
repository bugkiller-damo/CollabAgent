import { afterAll, describe, expect, it } from "vitest";
import {
  ACCESS_CACHE_TTL_MS,
  canAccessChannel,
  getChannelType,
  getMemberRole,
  invalidateChannel,
  invalidateMember,
  setAccessPubSub,
} from "../src/lib/access.js";
import { createPubSub } from "../src/lib/pubsub.js";
import { api, cleanupTestData, closeSql, registerUser, uniqHandle } from "./helpers.js";

// ===================== 单测：fake app（内存 DB + 查询计数） =====================

interface FakeDb {
  channels: Map<string, { server_id: string; type: string }>;
  members: Map<string, { role: string }>; // key: channelId:userId
  queries: number;
}

function makeFakeApp(db: FakeDb) {
  const pg = {
    query: async (sqlText: string, params: unknown[]) => {
      db.queries++;
      if (/FROM channels WHERE id = \$1/.test(sqlText)) {
        const row = db.channels.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (/FROM channel_members WHERE channel_id/.test(sqlText)) {
        const row = db.members.get(`${String(params[0])}:${String(params[1])}`);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
  return { pg } as any;
}

describe("access 缓存语义（O7）", () => {
  it("TTL 常量明确为 2000ms（兜底窗口语义）", () => {
    expect(ACCESS_CACHE_TTL_MS).toBe(2000);
  });

  it("频道信息缓存命中：两次查询只打一次 DB", async () => {
    const db: FakeDb = {
      channels: new Map([["c1", { server_id: "s1", type: "public" }]]),
      members: new Map(),
      queries: 0,
    };
    const app = makeFakeApp(db);
    expect(await getChannelType(app, "c1")).toBe("public");
    expect(await getChannelType(app, "c1")).toBe("public");
    expect(db.queries).toBe(1);
  });

  it("invalidateChannel 立即清缓存：下一次查询回源", async () => {
    const db: FakeDb = {
      channels: new Map([["c2", { server_id: "s1", type: "public" }]]),
      members: new Map(),
      queries: 0,
    };
    const app = makeFakeApp(db);
    await getChannelType(app, "c2");
    invalidateChannel("c2");
    expect(await getChannelType(app, "c2")).toBe("public");
    expect(db.queries).toBe(2);
  });

  it("invalidateMember 只清指定用户，同频道其它成员缓存保留", async () => {
    const db: FakeDb = {
      channels: new Map(),
      members: new Map([
        ["c3:u1", { role: "member" }],
        ["c3:u2", { role: "admin" }],
      ]),
      queries: 0,
    };
    const app = makeFakeApp(db);
    await getMemberRole(app, "c3", "u1");
    await getMemberRole(app, "c3", "u2");
    expect(db.queries).toBe(2);
    invalidateMember("c3", "u1");
    expect(await getMemberRole(app, "c3", "u2")).toBe("admin"); // 仍缓存
    expect(await getMemberRole(app, "c3", "u1")).toBe("member"); // 已回源
    expect(db.queries).toBe(3);
  });

  it("改类型后权限判定：无失效 = 旧值可见，失效 = 立即新值（时序语义）", async () => {
    const db: FakeDb = {
      channels: new Map([["c4", { server_id: "s1", type: "private" }]]),
      members: new Map(),
      queries: 0,
    };
    const app = makeFakeApp(db);
    // 私有频道非成员 → 拒绝（此时缓存 type=private）
    expect(await canAccessChannel(app, "c4", "u9")).toBe(false);
    // DB 已改为 public，但缓存未失效：2s 窗口内仍是旧判定
    db.channels.set("c4", { server_id: "s1", type: "public" });
    expect(await canAccessChannel(app, "c4", "u9")).toBe(false);
    // 变更点主动失效 → 下一次判定立即为新值
    invalidateChannel("c4");
    expect(await canAccessChannel(app, "c4", "u9")).toBe(true);
  });

  it("成员角色变更：失效后立即生效", async () => {
    const db: FakeDb = {
      channels: new Map([["c5", { server_id: "s1", type: "private" }]]),
      members: new Map([["c5:u7", { role: "member" }]]),
      queries: 0,
    };
    const app = makeFakeApp(db);
    expect(await getMemberRole(app, "c5", "u7")).toBe("member");
    db.members.delete("c5:u7"); // 被移除
    expect(await getMemberRole(app, "c5", "u7")).toBe("member"); // 缓存窗口内旧值
    invalidateMember("c5", "u7");
    expect(await getMemberRole(app, "c5", "u7")).toBeNull(); // 立即新值
  });

  it("pubsub 失效消息：有效载荷清缓存，脏数据忽略", async () => {
    const db: FakeDb = {
      channels: new Map([["c6", { server_id: "s1", type: "public" }]]),
      members: new Map([["c6:u3", { role: "member" }]]),
      queries: 0,
    };
    const app = makeFakeApp(db);
    const pubsub = createPubSub(null);
    setAccessPubSub(pubsub);
    await getChannelType(app, "c6");
    await getMemberRole(app, "c6", "u3");
    expect(db.queries).toBe(2);
    // 模拟远端实例发布的失效消息
    pubsub.publish("slock:access-inv:v1", { kind: "channel", channelId: "c6" });
    pubsub.publish("slock:access-inv:v1", { kind: "member", channelId: "c6", userId: "u3" });
    pubsub.publish("slock:access-inv:v1", { garbage: true }); // 脏数据不炸
    expect(await getChannelType(app, "c6")).toBe("public");
    expect(await getMemberRole(app, "c6", "u3")).toBe("member");
    expect(db.queries).toBe(4);
  });

  it("TTL 兜底：超过 2s 未失效的缓存自动过期", async () => {
    const db: FakeDb = {
      channels: new Map([["c7", { server_id: "s1", type: "public" }]]),
      members: new Map(),
      queries: 0,
    };
    const app = makeFakeApp(db);
    await getChannelType(app, "c7");
    await new Promise((r) => setTimeout(r, ACCESS_CACHE_TTL_MS + 200));
    expect(await getChannelType(app, "c7")).toBe("public");
    expect(db.queries).toBe(2);
  });
});

// ===================== 集成测试：变更立即生效（无 2s 窗口） =====================

describe("access: 权限变更立即生效（真服务器）", () => {
  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("私有→公开立即生效：非成员无需等待即可读", async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const name = `acc_${uniqHandle()}`;
    const created = await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name, type: "private" },
    });
    expect(created.status).toBe(200);
    const channelId = created.data.channel.id as string;

    // 非成员读私有频道 → 403
    expect((await api(`/api/messages?channel=%23${name}`, { cookie: outsider.cookie })).status).toBe(403);

    // 改为公开 → 非成员立即（无 sleep）可读
    const patched = await api(`/api/channels/${channelId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { type: "public" },
    });
    expect(patched.status).toBe(200);
    expect((await api(`/api/messages?channel=%23${name}`, { cookie: outsider.cookie })).status).toBe(200);
  });

  it("移除成员立即生效：被移除者马上 403", async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const name = `acc_${uniqHandle()}`;
    const created = await api("/api/channels", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { name, type: "private" },
    });
    const channelId = created.data.channel.id as string;
    const invited = await api(`/api/channels/${channelId}/invite`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { handle: member.handle },
    });
    expect(invited.status).toBe(200);
    expect((await api(`/api/messages?channel=%23${name}`, { cookie: member.cookie })).status).toBe(200);

    const removed = await api(`/api/channels/${channelId}/members/${member.userId}`, {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(removed.status).toBe(200);
    expect((await api(`/api/messages?channel=%23${name}`, { cookie: member.cookie })).status).toBe(403);
  });
});
