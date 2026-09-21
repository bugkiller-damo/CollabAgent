import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeInterruptStore, type PendingRuntimeInterrupt } from "../src/agent-runtime-interrupt-store.js";

/**
 * Phase 2：待恢复 interrupt 持久化（design §11.4）。
 * 键 (agentId, conversationId)；take 校验 runtime/entrypoint 兼容且未过期；
 * 一次性 token——恢复成功 delete，retry 保留。
 */

let dirs: string[] = [];
const tmpFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-interrupts-"));
  dirs.push(d);
  return join(d, "interrupts.json");
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const rec = (over: Partial<PendingRuntimeInterrupt> = {}): PendingRuntimeInterrupt => ({
  agentId: "a1",
  runtime: "langgraph",
  entrypoint: "ep-1",
  conversationId: "slock:v1:a1:thread:t1",
  interruptId: "i9",
  resumeToken: "r7",
  prompt: "批准？",
  createdAt: 1000,
  expiresAt: 0, // put 时由 ttlMs 补
  ...over,
});

describe("createRuntimeInterruptStore", () => {
  it("put/take/delete 往返 + 落盘持久化", () => {
    const path = tmpFile();
    const store = createRuntimeInterruptStore(path, { now: () => 2000 });
    store.put(rec());
    // 新实例读同一文件 → 跨重启可见
    const store2 = createRuntimeInterruptStore(path, { now: () => 2000 });
    const got = store2.take("a1", "slock:v1:a1:thread:t1", "langgraph", "ep-1");
    expect(got).toMatchObject({ interruptId: "i9", resumeToken: "r7", expiresAt: 2000 + 7 * 24 * 60 * 60 * 1000 });
    expect(store2.delete("a1", "slock:v1:a1:thread:t1")).toBe(true);
    expect(store2.take("a1", "slock:v1:a1:thread:t1", "langgraph", "ep-1")).toBeNull();
  });

  it("同 (agentId, conversationId) put 覆盖旧记录", () => {
    const store = createRuntimeInterruptStore(tmpFile());
    store.put(rec({ interruptId: "i1" }));
    store.put(rec({ interruptId: "i2", resumeToken: "r8" }));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ interruptId: "i2", resumeToken: "r8" });
  });

  it("runtime/entrypoint 不兼容 → take 清除并返回 null", () => {
    const store = createRuntimeInterruptStore(tmpFile());
    store.put(rec());
    expect(store.take("a1", "slock:v1:a1:thread:t1", "langchain", "ep-1")).toBeNull();
    expect(store.list()).toHaveLength(0);
    store.put(rec({ entrypoint: undefined }));
    expect(store.take("a1", "slock:v1:a1:thread:t1", "langgraph", "ep-1")).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("过期 → take 清除并返回 null", () => {
    let now = 1000;
    const store = createRuntimeInterruptStore(tmpFile(), { now: () => now, ttlMs: 100 });
    store.put(rec());
    now = 2000;
    expect(store.take("a1", "slock:v1:a1:thread:t1", "langgraph", "ep-1")).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("Phase 5：manifest revision 不兼容 → take 清除并返回 null", () => {
    const store = createRuntimeInterruptStore(tmpFile());
    store.put(rec({ revision: "rev-a" }));
    // 同 runtime/entrypoint 但 revision 不同（manifest 被改）→ 不兼容
    expect(store.take("a1", "slock:v1:a1:thread:t1", "langgraph", "ep-1", "rev-b")).toBeNull();
    expect(store.list()).toHaveLength(0);
    // revision 一致 → 兼容返回
    store.put(rec({ revision: "rev-a" }));
    expect(store.take("a1", "slock:v1:a1:thread:t1", "langgraph", "ep-1", "rev-a")?.resumeToken).toBe("r7");
  });

  it("Phase 5：clearIncompatible 只清不兼容记录，兼容的保留", () => {
    const store = createRuntimeInterruptStore(tmpFile());
    store.put(rec({ revision: "rev-a" }));
    store.put(rec({ agentId: "a1", conversationId: "slock:v1:a1:channel:c2", revision: "rev-a" }));
    store.put(rec({ agentId: "a1", conversationId: "slock:v1:a1:channel:c3", runtime: "langchain" }));
    store.put(rec({ agentId: "a2", conversationId: "slock:v1:a2:channel:c4", revision: "rev-b" }));
    // 当前身份变成 langgraph/ep-1/rev-b：a1 三条全不兼容（rev-a×2 + langchain×1），
    // a2 的记录不受波及（只管本 agent）。
    expect(store.clearIncompatible("a1", "langgraph", "ep-1", "rev-b")).toBe(3);
    const rest = store.list();
    expect(rest).toHaveLength(1);
    expect(rest[0]!.agentId).toBe("a2");
  });

  it("Phase 5：clearIncompatible 保留同身份记录", () => {
    const store = createRuntimeInterruptStore(tmpFile());
    store.put(rec({ revision: "rev-a" }));
    store.put(rec({ agentId: "a1", conversationId: "slock:v1:a1:channel:c2", revision: "rev-a" }));
    expect(store.clearIncompatible("a1", "langgraph", "ep-1", "rev-a")).toBe(0);
    expect(store.list()).toHaveLength(2);
  });

  it("clearAgent 只清目标 agent", () => {
    const store = createRuntimeInterruptStore(tmpFile());
    store.put(rec());
    store.put(rec({ agentId: "a2", conversationId: "slock:v1:a2:channel:c" }));
    expect(store.clearAgent("a1")).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.agentId).toBe("a2");
    expect(store.clearAgent("a1")).toBe(0);
  });

  it("损坏文件 → 空集起步不炸", () => {
    const path = tmpFile();
    writeFileSync(path, "{oops", "utf-8");
    const store = createRuntimeInterruptStore(path);
    expect(store.list()).toEqual([]);
  });

  it("原子写：落盘 JSON 结构正确", () => {
    const path = tmpFile();
    createRuntimeInterruptStore(path).put(rec());
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0].resumeToken).toBe("r7");
  });
});
