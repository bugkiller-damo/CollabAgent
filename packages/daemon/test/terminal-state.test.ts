import { describe, it, expect } from "vitest";
import { createTerminalState } from "../src/terminal-state.js";

/**
 * scrollback=1000 引入后的视口正确性回归（2026-07-19 实测 bug）：
 * getScreenText 必须读「当前视口」（baseY 起），而不是缓冲区最开头的历史行——
 * 否则一旦输出超过一屏，screenText 就永远定格在会话开头的启动画面，
 * 终端面板只能看到启动系统消息，回合结束检测也会一起失效。
 */
describe("terminal-state viewport vs scrollback", () => {
  it("getScreenText returns the current viewport after content scrolls past the screen", async () => {
    const t = createTerminalState(80, 5);
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    await new Promise<void>((resolve) => t.write(lines.join("\r\n") + "\r\n", () => resolve()));

    const screen = t.getScreenText();
    // 当前视口应包含最新的行，而不是缓冲区开头的历史行
    expect(screen).toContain("line-49");
    expect(screen).not.toContain("line-0");

    // 历史接口则应该能看到 scrollback 里的老行
    const history = t.getHistoryText(200);
    expect(history).toContain("line-0");
    expect(history).toContain("line-49");
    t.dispose();
  });

  it("getScreenText still works when content fits within one screen", async () => {
    const t = createTerminalState(80, 24);
    await new Promise<void>((resolve) => t.write("hello world\r\n", () => resolve()));
    expect(t.getScreenText()).toContain("hello world");
    t.dispose();
  });
});
