import type { PendingInterruptSummary } from "@collabagent/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useInterruptStore } from "./interruptStore";

/**
 * 批次 C（P1.4）：pending interrupt 审批面 store——per-machine 全量快照置换
 * + 频道/线程/DM 语境过滤。摘要只含安全字段（resumeToken 从不出 daemon）。
 */

beforeEach(() => {
  setActivePinia(createPinia());
});

const rec = (over: Partial<PendingInterruptSummary> = {}): PendingInterruptSummary => ({
  agentId: "a1",
  agentName: "researcher",
  conversationId: "slock:v1:a1:channel:general",
  interruptId: "i1",
  prompt: "批准部署？",
  runtime: "langgraph",
  channel: "general",
  createdAt: 1000,
  expiresAt: Date.now() + 60_000,
  ...over,
});

describe("interruptStore", () => {
  it("setMachine 按 machineUuid 整体置换；空表清掉该机条目", () => {
    const store = useInterruptStore();
    store.setMachine("m1", [rec()]);
    store.setMachine("m2", [rec({ agentId: "a2", conversationId: "c2", interruptId: "i2" })]);
    expect(store.all).toHaveLength(2);

    // 同机重推 = 置换不是合并（旧记录被新快照覆盖）
    store.setMachine("m1", []);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.agentId).toBe("a2");
    expect(store.byMachine.m1).toBeUndefined();
  });

  it("machineUuid 缺省归一到空键，不炸", () => {
    const store = useInterruptStore();
    store.setMachine(null, [rec()]);
    expect(store.all).toHaveLength(1);
    store.setMachine(undefined, []);
    expect(store.all).toHaveLength(0);
  });

  it("forChannel：threadId 精确匹配——顶层与线程 pending 互不串扰", () => {
    const store = useInterruptStore();
    store.setMachine("m1", [
      rec({ interruptId: "i-top", conversationId: "c-top" }), // 频道顶层（无 threadId）
      rec({ interruptId: "i-th", conversationId: "c-th", threadId: "th-1" }),
      rec({ interruptId: "i-other", conversationId: "c-o", channel: "ops", threadId: "th-1" }),
    ]);
    expect(store.forChannel("general").map((i) => i.interruptId)).toEqual(["i-top"]);
    expect(store.forChannel("general", "th-1").map((i) => i.interruptId)).toEqual(["i-th"]);
    expect(store.forChannel("ops", "th-1").map((i) => i.interruptId)).toEqual(["i-other"]);
    expect(store.forChannel("missing")).toEqual([]);
  });

  it("forChannelAll：频道页聚合——顶层 + 全部线程项", () => {
    const store = useInterruptStore();
    store.setMachine("m1", [
      rec({ interruptId: "i-top", conversationId: "c-top" }),
      rec({ interruptId: "i-th", conversationId: "c-th", threadId: "th-1" }),
      rec({ interruptId: "i-else", conversationId: "c-e", channel: "random" }),
    ]);
    expect(store.forChannelAll("general").map((i) => i.interruptId)).toEqual(["i-top", "i-th"]);
  });

  it("forDm：agentId + dm: 前缀双限定", () => {
    const store = useInterruptStore();
    store.setMachine("m1", [
      rec({ interruptId: "i-dm", conversationId: "slock:v1:a1:dm:u1", channel: "dm:@u1" }),
      rec({ interruptId: "i-ch", conversationId: "c-ch" }), // 同 agent 的频道 pending 不进 DM
      rec({ interruptId: "i-other", agentId: "a9", conversationId: "c9", channel: "dm:@u1" }),
    ]);
    expect(store.forDm("a1").map((i) => i.interruptId)).toEqual(["i-dm"]);
    expect(store.forDm(undefined)).toEqual([]);
    expect(store.forDm("ghost")).toEqual([]);
  });
});
