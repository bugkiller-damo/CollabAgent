import { describe, expect, it } from "vitest";
import { BUSY_MARKER_RE, PROMPT_RE } from "../src/agent-runtime.js";

/**
 * 回合结束检测用到的两个正则的独立测试。真正的"忙碌观测"状态机（busyObservedByAgent /
 * hasBeenBusy）在 fake-agent-manager 集成测试里覆盖（见 round-end.integration.test.ts），
 * 这里只锁定这两个正则本身在各种实际观测过的屏幕文本上的匹配结果。
 */

describe("BUSY_MARKER_RE", () => {
  it("matches the standard 'esc to interrupt' busy footer", () => {
    expect(BUSY_MARKER_RE.test("⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for ag…")).toBe(
      true,
    );
  });

  it("is case-insensitive and tolerates extra whitespace", () => {
    expect(BUSY_MARKER_RE.test("ESC   TO   INTERRUPT")).toBe(true);
  });

  it("does not match the idle footer", () => {
    expect(BUSY_MARKER_RE.test("⏵⏵ bypass permissions on (shift+tab to cycle)  ctrl+g to edit in Notepad.exe")).toBe(
      false,
    );
  });
});

describe("PROMPT_RE", () => {
  it("matches ❯ anywhere, no leading-newline required (live bug 10 regression)", () => {
    expect(PROMPT_RE.test("✻Cooked for2m 42s❯ ← for agents")).toBe(true);
  });

  it("matches the alternate › glyph", () => {
    expect(PROMPT_RE.test("some › text")).toBe(true);
  });

  it("does not match plain ASCII '>' (avoids false positives on ordinary text)", () => {
    expect(PROMPT_RE.test("if x > 0 then")).toBe(false);
  });
});
