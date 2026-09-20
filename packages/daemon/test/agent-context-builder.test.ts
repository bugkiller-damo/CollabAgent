import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChannelContextEnvelope,
  contextBuilderEnabled,
  normalizeThreadId,
  packThreadContext,
  prependContext,
  readContextBudget,
  readToplevelContextBudget,
  wrapWithIsolation,
} from "../src/agent-context-builder.js";

const msg = (id: string, seq: number, senderName: string, content: string) => ({
  id,
  seq,
  senderName,
  content,
});

describe("packThreadContext", () => {
  it("keeps chronological order and drops the trigger message by id", () => {
    const packed = packThreadContext(
      [
        msg("t", 3, "bob", "please fix it @alice"),
        msg("a", 1, "alice", "bug in login"),
        msg("b", 2, "carol", "repro on staging"),
      ],
      { triggerId: "t", maxMessages: 40, maxChars: 8000 },
    );
    expect(packed).not.toBeNull();
    expect(packed!.kept).toBe(2);
    expect(packed!.dropped).toBe(0);
    expect(packed!.block).toContain("@alice: bug in login");
    expect(packed!.block).toContain("@carol: repro on staging");
    expect(packed!.block).not.toContain("please fix it");
    const aliceAt = packed!.block.indexOf("bug in login");
    const carolAt = packed!.block.indexOf("repro on staging");
    expect(aliceAt).toBeLessThan(carolAt);
  });

  it("drops oldest messages when over maxMessages", () => {
    const packed = packThreadContext([msg("1", 1, "a", "old"), msg("2", 2, "b", "mid"), msg("3", 3, "c", "new")], {
      maxMessages: 2,
      maxChars: 8000,
    });
    expect(packed!.kept).toBe(2);
    expect(packed!.dropped).toBe(1);
    expect(packed!.block).not.toContain("old");
    expect(packed!.block).toContain("mid");
    expect(packed!.block).toContain("new");
  });

  it("drops oldest until under maxChars", () => {
    const packed = packThreadContext([msg("1", 1, "a", "AAAAAAAAAA"), msg("2", 2, "b", "BB"), msg("3", 3, "c", "CC")], {
      maxMessages: 40,
      maxChars: 20,
    });
    expect(packed).not.toBeNull();
    expect(packed!.block).not.toContain("AAAAAAAAAA");
    expect(packed!.block).toContain("@c: CC");
  });

  it("returns null for empty / whitespace-only history", () => {
    expect(packThreadContext([])).toBeNull();
    expect(packThreadContext([{ id: "x", seq: 1, senderName: "a", content: "   " }])).toBeNull();
  });

  it("drops in-channel ⏳ progress messages", () => {
    const packed = packThreadContext(
      [msg("1", 1, "alice", "⏳ 正在读文件 a.ts…"), msg("2", 2, "bob", "please continue")],
      { maxMessages: 40, maxChars: 8000 },
    );
    expect(packed!.block).not.toContain("正在读文件");
    expect(packed!.block).toContain("please continue");
  });

  it("dedupes trigger by content when id is missing", () => {
    const packed = packThreadContext([msg("1", 1, "a", "hello"), msg("2", 2, "b", "followup")], {
      triggerContent: "followup",
    });
    expect(packed!.block).toContain("hello");
    expect(packed!.block).not.toContain("followup");
  });
});

describe("wrapWithIsolation + prependContext", () => {
  it("puts isolation + thread block before the task prompt", () => {
    const packed = packThreadContext([msg("1", 1, "a", "earlier")])!;
    const envelope = wrapWithIsolation(packed.block, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const out = prependContext(envelope, "你在线程里被 @ 了。");
    expect(out.startsWith("【会话隔离】")).toBe(true);
    expect(out).toContain("【线程上下文】");
    expect(out).toContain("@a: earlier");
    expect(out).toContain("你在线程里被 @ 了。");
    expect(out.indexOf("【线程上下文】")).toBeLessThan(out.indexOf("你在线程里被 @ 了。"));
  });
});

describe("normalizeThreadId / env gates", () => {
  it("treats blank threadId as absent", () => {
    expect(normalizeThreadId("")).toBeUndefined();
    expect(normalizeThreadId("  ")).toBeUndefined();
    expect(normalizeThreadId("abc")).toBe("abc");
  });

  it("SLOCK_CONTEXT_BUILDER=0 disables builder", () => {
    expect(contextBuilderEnabled({ SLOCK_CONTEXT_BUILDER: "0" })).toBe(false);
    expect(contextBuilderEnabled({})).toBe(true);
  });

  it("reads budget env with fallbacks", () => {
    expect(readContextBudget({})).toEqual({ maxMessages: 40, maxChars: 8000 });
    expect(readContextBudget({ SLOCK_CONTEXT_MAX_MESSAGES: "10", SLOCK_CONTEXT_MAX_CHARS: "100" })).toEqual({
      maxMessages: 10,
      maxChars: 100,
    });
  });

  it("A3/§8.6：顶层小预算默认 8 条/2000 字符，env 可覆盖", () => {
    expect(readToplevelContextBudget({})).toEqual({ maxMessages: 8, maxChars: 2000 });
    expect(
      readToplevelContextBudget({
        SLOCK_CONTEXT_TOPLEVEL_MAX_MESSAGES: "4",
        SLOCK_CONTEXT_TOPLEVEL_MAX_CHARS: "500",
      }),
    ).toEqual({ maxMessages: 4, maxChars: 500 });
    // 非法值回退默认
    expect(readToplevelContextBudget({ SLOCK_CONTEXT_TOPLEVEL_MAX_MESSAGES: "x" })).toEqual({
      maxMessages: 8,
      maxChars: 2000,
    });
  });
});

// A3/§8.6：顶层 @ / DM 的小预算上下文——同 /history 端点不带 threadId，
// 不用线程隔离信封。fetch 用 vi.stubGlobal 打桩。
describe("buildChannelContextEnvelope（顶层/DM 小预算）", () => {
  const input = {
    serverUrl: "http://fake.test",
    apiKey: "k",
    agentId: "agent-1",
  };

  const stubFetch = (impl: (url: string) => unknown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: any) => {
        const out = impl(String(u));
        if (out instanceof Error) throw out;
        return { ok: true, status: 200, json: async () => out, text: async () => "" } as Response;
      }),
    );
    return vi.mocked(globalThis.fetch);
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("顶层频道：channel=#general、无 threadId、用频道标签与小预算", async () => {
    const fetchMock = stubFetch(() => ({
      messages: [msg("m1", 1, "bob", "刚部署了 v2"), msg("m2", 2, "alice", "看下日志")],
    }));
    const built = await buildChannelContextEnvelope({ ...input, channelName: "general", env: {} });
    expect(built).not.toBeNull();
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("channel")).toBe("#general");
    expect(url.searchParams.get("threadId")).toBeNull();
    expect(url.searchParams.get("limit")).toBe("20"); // max(8*2, 20)
    expect(built!.envelope).toContain("【频道近期上下文】");
    expect(built!.envelope).toContain("刚部署了 v2");
    expect(built!.envelope).not.toContain("【会话隔离】"); // 顶层不套线程隔离
  });

  it("DM：channel=dm:@bob 原样透传、用私信标签", async () => {
    const fetchMock = stubFetch(() => ({ messages: [msg("m1", 1, "bob", "在吗")] }));
    const built = await buildChannelContextEnvelope({ ...input, channelName: "dm:@bob", env: {} });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("channel")).toBe("dm:@bob");
    expect(built!.envelope).toContain("【私信近期上下文】");
  });

  it("触发消息按 id / 正文去重", async () => {
    stubFetch(() => ({
      messages: [msg("t", 1, "bob", "@alice 看下"), msg("m2", 2, "carol", "背景信息")],
    }));
    const built = await buildChannelContextEnvelope({
      ...input,
      channelName: "general",
      triggerId: "t",
      env: {},
    });
    expect(built!.envelope).not.toContain("看下");
    expect(built!.envelope).toContain("背景信息");
  });

  it("fetch 失败 / 无历史 / 关闭 → null（裸 prompt，不阻断）", async () => {
    stubFetch(() => new Error("network down"));
    expect(await buildChannelContextEnvelope({ ...input, channelName: "general", env: {} })).toBeNull();

    stubFetch(() => ({ messages: [] }));
    expect(await buildChannelContextEnvelope({ ...input, channelName: "general", env: {} })).toBeNull();

    const fetchMock = stubFetch(() => ({ messages: [msg("m", 1, "a", "hi")] }));
    expect(
      await buildChannelContextEnvelope({ ...input, channelName: "general", env: { SLOCK_CONTEXT_BUILDER: "0" } }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await buildChannelContextEnvelope({ ...input, channelName: "  ", env: {} })).toBeNull();
  });

  it("env 预算收紧：SLOCK_CONTEXT_TOPLEVEL_MAX_MESSAGES=1 只留最新一条", async () => {
    stubFetch(() => ({
      messages: [msg("m1", 1, "a", "旧消息"), msg("m2", 2, "b", "新消息")],
    }));
    const built = await buildChannelContextEnvelope({
      ...input,
      channelName: "general",
      env: { SLOCK_CONTEXT_TOPLEVEL_MAX_MESSAGES: "1" },
    });
    expect(built!.envelope).not.toContain("旧消息");
    expect(built!.envelope).toContain("新消息");
  });
});
