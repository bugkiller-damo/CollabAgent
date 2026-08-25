import { describe, expect, it } from "vitest";
import {
  contextBuilderEnabled,
  normalizeThreadId,
  packThreadContext,
  prependContext,
  readContextBudget,
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
});
