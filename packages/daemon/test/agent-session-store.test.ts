import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonAgentSessionStore, type IAgentSessionStore } from "../src/agent-session-store.js";

/**
 * A2：agent→sessionId 续接盘（daemon-agent-sessions.json）。
 * 钉住：upsert / forget / 跨实例持久化（daemon 重启 = 新 store 实例同文件）。
 */
describe("agent-session-store (A2)", () => {
  let store: IAgentSessionStore;
  let storePath: string;

  beforeEach(() => {
    storePath = join(tmpdir(), `slock-agent-sess-${randomUUID()}.json`);
    store = createJsonAgentSessionStore(storePath, { now: () => 1000 });
  });

  afterEach(() => {
    try {
      rmSync(storePath, { force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(storePath + ".tmp", { force: true });
    } catch {
      /* best-effort */
    }
  });

  it("remember 按 agentName upsert；lookup 取最新 sessionId", () => {
    store.remember("alice", "sess-1");
    store.remember("bob", "sess-2");
    store.remember("alice", "sess-1b");
    expect(store.lookup("alice")?.sessionId).toBe("sess-1b");
    expect(store.lookup("bob")?.sessionId).toBe("sess-2");
    expect(store.lookup("carol")).toBeNull();
  });

  it("空 agentName / sessionId 不落库", () => {
    expect(store.remember("", "s")).toBeNull();
    expect(store.remember("a", "  ")).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("forget 删除记录；不存在的名字返回 false", () => {
    store.remember("alice", "sess-1");
    expect(store.forget("alice")).toBe(true);
    expect(store.lookup("alice")).toBeNull();
    expect(store.forget("alice")).toBe(false);
    // 其它 agent 的记录不受影响
    store.remember("bob", "sess-2");
    expect(store.forget("alice")).toBe(false);
    expect(store.lookup("bob")?.sessionId).toBe("sess-2");
  });

  it("跨 store 实例持久化（daemon 重启后仍能 resume）", () => {
    store.remember("alice", "sess-abc");
    const reopened = createJsonAgentSessionStore(storePath);
    expect(reopened.lookup("alice")?.sessionId).toBe("sess-abc");
    reopened.forget("alice");
    expect(store.lookup("alice")).toBeNull();
  });

  it("损坏 JSON → 空表 + 不抛", () => {
    writeFileSync(storePath, "{not json", "utf-8");
    expect(store.lookup("alice")).toBeNull();
    store.remember("alice", "sess-1"); // 覆盖重写恢复正常
    expect(store.lookup("alice")?.sessionId).toBe("sess-1");
  });
});
