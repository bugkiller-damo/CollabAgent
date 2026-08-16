import { describe, expect, it } from "vitest";
import {
  commandBaseName,
  hasInteractivePromptReady,
  hasPasteAck,
  toBracketedPasteSubmission,
} from "../src/post-start-input-writer.js";

describe("hasInteractivePromptReady", () => {
  it("detects the standard boxed empty-input prompt", () => {
    const screen = [
      "▐▛███▜▌ Claude Code v2.1.211",
      "────────────────────────────",
      "❯",
      "────────────────────────────",
      "⏵⏵ bypass permissions on (shift+tab to cycle)  ctrl+g to edit in Notepad.exe",
    ].join("\n");
    expect(hasInteractivePromptReady(screen)).toBe(true);
  });

  it("detects the compact no-newline completion frame (live bug 10 repro)", () => {
    // 实际观测到的失败帧：❯ 紧跟在 "42s" 后面，没有换行分隔
    expect(hasInteractivePromptReady("✻Cooked for2m 42s❯ ← for agents")).toBe(true);
  });

  it("detects the alternate chevron character ›", () => {
    expect(hasInteractivePromptReady("some text › more text")).toBe(true);
  });

  it("returns false when no prompt glyph is present at all", () => {
    expect(hasInteractivePromptReady("✻ Philosophising… (esc to interrupt)")).toBe(false);
  });

  it("returns false on empty string", () => {
    expect(hasInteractivePromptReady("")).toBe(false);
  });
});

describe("hasPasteAck", () => {
  it("detects the Claude paste-ack placeholder", () => {
    expect(hasPasteAck("[Pasted text #1 +42 lines]")).toBe(true);
  });

  it("detects the placeholder embedded in a larger screen", () => {
    expect(hasPasteAck("some prior text\n[Pasted text #3 +120 lines]\n❯")).toBe(true);
  });

  it("returns false when the raw pasted text is shown instead of a placeholder", () => {
    // 实机联调里见过的情况：Claude 没有把粘贴内容折叠成占位符，是原文直接躺在屏幕上
    expect(hasPasteAck("你在 #general 频道被 @ 了。来自 @bugkiller 的消息：你好")).toBe(false);
  });

  it("returns false on empty string", () => {
    expect(hasPasteAck("")).toBe(false);
  });
});

describe("commandBaseName (live bug 12 regression)", () => {
  it("extracts the bare name from an absolute Windows path with .exe", () => {
    expect(
      commandBaseName(
        String.raw`C:\Users\14431\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
      ),
    ).toBe("claude");
  });

  it("extracts the bare name from an absolute posix path", () => {
    expect(commandBaseName("/usr/local/bin/claude")).toBe("claude");
  });

  it("passes through a bare literal command name unchanged", () => {
    expect(commandBaseName("claude")).toBe("claude");
  });

  it("strips .cmd and .bat extensions and lowercases", () => {
    expect(commandBaseName(String.raw`C:\tools\Codex.CMD`)).toBe("codex");
    expect(commandBaseName(String.raw`C:\tools\OPENCODE.bat`)).toBe("opencode");
  });
});

describe("toBracketedPasteSubmission", () => {
  it("wraps text in the bracketed-paste escape sequence", () => {
    expect(toBracketedPasteSubmission("hello")).toBe("\x1b[200~hello\x1b[201~");
  });
});
