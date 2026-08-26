import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P1.15：terminal-log 落盘脱敏 + .slock 目录 0700。
// LOG_DIR 在模块加载时按 process.cwd() 固定，故每个用例 chdir 到临时目录后
// 动态 import（vi.resetModules 保证拿到按新 cwd 计算的 LOG_DIR）。
const AGENT_TOKEN = "sk_agent_abcd1234abcd1234abcd1234abcd1234";

describe("terminal-log（P1.15）", () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "slock-termlog-"));
    vi.resetModules();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("落盘文本中的 sk_agent_ token 被脱敏", async () => {
    const { appendTerminalLog, readTerminalLogTail } = await import("../src/terminal-log.js");
    appendTerminalLog("alice", "run-1234567890", 0, `输出里带了 ${AGENT_TOKEN} 完了`);
    const tail = readTerminalLogTail("alice");
    expect(tail).not.toContain(AGENT_TOKEN);
    expect(tail).toContain("sk_agent_***");
    expect(tail).toContain("输出里带了");
  });

  it("不含 token 的文本原样落盘", async () => {
    const { appendTerminalLog, readTerminalLogTail } = await import("../src/terminal-log.js");
    appendTerminalLog("bob", "run-abcdef1234", 0, "普通输出 hello");
    expect(readTerminalLogTail("bob")).toContain("普通输出 hello");
  });

  it("POSIX 下 .slock/terminal-logs 目录为 0700（Windows 跳过 mode 断言）", async () => {
    if (process.platform === "win32") return;
    const { appendTerminalLog } = await import("../src/terminal-log.js");
    appendTerminalLog("alice", "run-x", 0, "hi");
    expect(statSync(join(tmp, ".slock", "terminal-logs")).mode & 0o777).toBe(0o700);
  });
});
