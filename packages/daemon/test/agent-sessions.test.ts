import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureSessionId, listSessions, mangleClaudeProjectPath } from "../src/agent-sessions.js";

/**
 * 回归测试：`captureSessionId("claude", workspaceDir)` 之前扫的是
 * `{workspace}/.claude/projects/`，但 Claude Code 实际把会话记录写在
 * `~/.claude/projects/<mangled-abs-path>/`（用户主目录下，不是项目目录本身）
 * ——之前的实现在生产环境里会一直返回 null，静默地让 session resume 整个
 * 失效。这里不 mock 文件系统：真的在这台机器的 `~/.claude/projects/` 下建一个
 * 用随机 uuid 命名、明显是测试产物的子目录，跑完删掉——用真实路径验证
 * mangleClaudeProjectPath 的字符替换规则（对着这台机器上 Claude Code 自己
 * 生成的真实目录名核实过，见 agent-sessions.ts 顶部注释），比 mock 更能确认
 * "这条路径在真实文件系统上真的行得通"。
 */
describe("agent-sessions.ts — claude session file discovery", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("mangleClaudeProjectPath replaces every non-alphanumeric character 1:1 with '-' (verified against this machine's real ~/.claude/projects/ dir names)", () => {
    // 这几个断言直接对应本机 ~/.claude/projects/ 下真实存在的目录名
    // （D--code-slock-packages-daemon 等），不是凭空构造的期望值。
    expect(mangleClaudeProjectPath("D:\\code\\slock\\packages\\daemon")).toBe("D--code-slock-packages-daemon");
    expect(mangleClaudeProjectPath("D:\\code\\slock")).toBe("D--code-slock");
    // 连续多个特殊字符（冒号+反斜杠）应该各自贡献一个'-'，不合并
    expect(mangleClaudeProjectPath("C:\\a")).toBe("C--a");
  });

  it("finds the most recently modified session file under ~/.claude/projects/<mangled-workspace>, not under {workspace}/.claude/projects", () => {
    const workspaceDir = join(tmpdir(), `slock-agent-sessions-test-${randomUUID()}`);
    const mangled = mangleClaudeProjectPath(workspaceDir);
    const projectDir = join(homedir(), ".claude", "projects", mangled);
    mkdirSync(projectDir, { recursive: true });
    createdDirs.push(projectDir);

    const olderId = randomUUID();
    const newerId = randomUUID();
    const olderFile = join(projectDir, `${olderId}.jsonl`);
    const newerFile = join(projectDir, `${newerId}.jsonl`);
    writeFileSync(olderFile, "{}\n");
    writeFileSync(newerFile, "{}\n");
    // 显式设置 mtime，不依赖两次 writeFileSync 之间的系统时钟精度差
    const now = Date.now();
    utimesSync(olderFile, new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(newerFile, new Date(now), new Date(now));

    expect(captureSessionId("claude", workspaceDir)).toBe(newerId);
    expect(listSessions("claude", workspaceDir).sort()).toEqual([olderId, newerId].sort());
  });

  it("returns null (not throw) when no session directory exists yet for this workspace", () => {
    const workspaceDir = join(tmpdir(), `slock-agent-sessions-test-nonexistent-${randomUUID()}`);
    expect(captureSessionId("claude", workspaceDir)).toBeNull();
  });
});
