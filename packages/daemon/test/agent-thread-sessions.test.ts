import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonThreadSessionStore, type IThreadSessionStore } from "../src/agent-thread-sessions.js";

describe("agent-thread-sessions", () => {
  let store: IThreadSessionStore;
  let storePath: string;

  beforeEach(() => {
    storePath = join(tmpdir(), `slock-thread-sess-${randomUUID()}.json`);
    store = createJsonThreadSessionStore(storePath, { now: () => 1000 });
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

  it("upserts by (agentName, threadId) and looks up the latest sessionId", () => {
    store.remember("alice", "thread-a", "sess-1");
    store.remember("alice", "thread-b", "sess-2");
    store.remember("alice", "thread-a", "sess-1b");
    expect(store.lookup("alice", "thread-a")?.sessionId).toBe("sess-1b");
    expect(store.lookup("alice", "thread-b")?.sessionId).toBe("sess-2");
    expect(store.lookup("bob", "thread-a")).toBeNull();
  });

  it("ignores blank keys", () => {
    expect(store.remember("", "t", "s")).toBeNull();
    expect(store.remember("a", "", "s")).toBeNull();
    expect(store.remember("a", "t", "  ")).toBeNull();
  });

  it("lists optionally filtered by agent", () => {
    store.remember("alice", "t1", "s1");
    store.remember("bob", "t1", "s2");
    expect(
      store
        .list()
        .map((r) => r.agentName)
        .sort(),
    ).toEqual(["alice", "bob"]);
    expect(store.list({ agentName: "alice" })).toHaveLength(1);
  });
});
