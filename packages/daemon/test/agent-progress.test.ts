import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProgressTurn,
  formatProgressMessage,
  isProgressContent,
  labelTool,
  PROGRESS_PREFIX,
  summarizeProgress,
} from "../src/agent-progress.js";

describe("labelTool", () => {
  it("maps built-in tools to Chinese labels", () => {
    expect(labelTool("Read")).toBe("读文件");
    expect(labelTool("Bash")).toBe("运行命令");
    expect(labelTool("mcp__slock__send_message")).toBe("发消息");
    expect(labelTool("mcp__slock__dispatch_task")).toBe("派单");
  });
  it("falls back to short name", () => {
    expect(labelTool("mcp__other__FooBar")).toBe("FooBar");
  });
});

describe("summarizeProgress + formatProgressMessage", () => {
  const f = (kind: string, payload: Record<string, unknown>) => ({ kind, payload });

  it("headline is the latest unfinished tool with file basename", () => {
    const snap = summarizeProgress([
      f("tool_use", { toolName: "Read", toolUseId: "1", text: JSON.stringify({ file_path: "D:/a/login.ts" }) }),
      f("tool_result", { toolUseId: "1", text: "ok" }),
      f("tool_use", { toolName: "Bash", toolUseId: "2", text: JSON.stringify({ command: "pnpm vitest run" }) }),
    ]);
    expect(snap.headline).toContain("运行命令");
    expect(snap.headline).toContain("pnpm vitest run");
    expect(snap.tools[0].done).toBe(true);
    expect(snap.tools[1].done).toBe(false);
  });

  it("thinking-only → 思考", () => {
    expect(summarizeProgress([f("thinking", { text: "hmm" })]).headline).toBe("思考");
  });

  it("headline resets after turn_end (second turn shouldn't stick on last tool)", () => {
    const snap = summarizeProgress([
      f("tool_use", { toolName: "Read", toolUseId: "1", text: JSON.stringify({ file_path: "a.ts" }) }),
      f("tool_result", { toolUseId: "1", text: "ok" }),
      f("turn_end", { summary: "success" }),
      f("thinking", { text: "下一问" }),
    ]);
    expect(snap.headline).toBe("思考");
    expect(snap.tools).toHaveLength(0);
  });

  it("empty window after turn_end has no in-progress headline", () => {
    const snap = summarizeProgress([
      f("tool_use", { toolName: "Read", toolUseId: "1", text: '{"file_path":"a.ts"}' }),
      f("turn_end", { summary: "success" }),
    ]);
    expect(snap.headline).toBe("");
    expect(snap.tools).toHaveLength(0);
  });

  it("progress message starts with prefix and lists recent tools", () => {
    const snap = summarizeProgress([
      f("tool_use", { toolName: "Read", toolUseId: "1", text: JSON.stringify({ file_path: "a.ts" }) }),
    ]);
    const text = formatProgressMessage(snap);
    expect(isProgressContent(text)).toBe(true);
    expect(text.startsWith(PROGRESS_PREFIX)).toBe(true);
    expect(text).toContain("读文件");
  });
});

describe("createProgressTurn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts once then throttles edits; finish removes", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const edits: string[] = [];
    const removed: string[] = [];
    const turn = createProgressTurn({
      agentName: "alice",
      channel: "general",
      now: () => Date.now(),
      throttleMs: 2000,
      enabled: true,
      poster: {
        async post(_ch, content) {
          posts.push(content);
          return "mid-1";
        },
        async edit(_id, content) {
          edits.push(content);
          return true;
        },
        async remove(id) {
          removed.push(id);
          return true;
        },
      },
    });

    turn.note({ kind: "tool_use", payload: { toolName: "Read", toolUseId: "1", text: '{"file_path":"a.ts"}' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);

    turn.note({ kind: "tool_result", payload: { toolUseId: "1", text: "ok" } });
    turn.note({ kind: "tool_use", payload: { toolName: "Bash", toolUseId: "2", text: '{"command":"ls"}' } });
    await vi.advanceTimersByTimeAsync(500);
    expect(edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(edits.length).toBeGreaterThanOrEqual(1);

    await turn.finish({ hadSend: true });
    expect(removed).toEqual(["mid-1"]);
  });

  it("finish rewrite replaces progress with final text", async () => {
    const edits: string[] = [];
    const turn = createProgressTurn({
      agentName: "alice",
      channel: "general",
      throttleMs: 0,
      enabled: true,
      poster: {
        async post() {
          return "mid-1";
        },
        async edit(_id, content) {
          edits.push(content);
          return true;
        },
        async remove() {
          throw new Error("should rewrite not remove");
        },
      },
    });
    turn.note({ kind: "text", payload: { text: "答案" } });
    await Promise.resolve();
    await turn.finish({ hadSend: false, rewrite: "答案" });
    expect(edits.at(-1)).toBe("答案");
  });

  it("SLOCK_CHANNEL_PROGRESS=0 never posts", async () => {
    const posts: string[] = [];
    const turn = createProgressTurn({
      agentName: "alice",
      channel: "general",
      enabled: false,
      poster: {
        async post(_c, content) {
          posts.push(content);
          return "x";
        },
        async edit() {
          return true;
        },
        async remove() {
          return true;
        },
      },
    });
    turn.note({ kind: "tool_use", payload: { toolName: "Read" } });
    await turn.finish({ hadSend: true });
    expect(posts).toHaveLength(0);
  });
});
