import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentTokenFilePath, removeAgentTokenFile, writeAgentTokenFile } from "../src/agent-token-file.js";
import { loadAgentContext } from "../src/auth.js";

// O11：token 文件传递机制 + loadAgentContext 的 TOKEN_FILE 解析路径
const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "slock-tokenfile-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("agent-token-file", () => {
  it("写入 workspace/.slock/agent-token，内容一致，返回路径可用", () => {
    const ws = mkWorkspace();
    const p = writeAgentTokenFile(ws, "sk_agent_test_123");
    expect(p).toBe(agentTokenFilePath(ws));
    expect(readFileSync(p, "utf-8")).toBe("sk_agent_test_123");
  });

  it("POSIX 下文件权限为 0600（Windows 跳过 mode 断言）", () => {
    if (process.platform === "win32") return;
    const ws = mkWorkspace();
    const p = writeAgentTokenFile(ws, "sk_agent_test_mode");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("POSIX 下 .slock 目录权限为 0700（P1.15；Windows 跳过）", () => {
    if (process.platform === "win32") return;
    const ws = mkWorkspace();
    writeAgentTokenFile(ws, "sk_agent_test_dirmode");
    expect(statSync(join(ws, ".slock")).mode & 0o777).toBe(0o700);
  });

  it("重复写覆盖旧 token（同一路径不滞留旧值）", () => {
    const ws = mkWorkspace();
    const p = writeAgentTokenFile(ws, "sk_agent_old");
    writeAgentTokenFile(ws, "sk_agent_new");
    expect(readFileSync(p, "utf-8")).toBe("sk_agent_new");
  });

  it("removeAgentTokenFile 删除文件；重复删除/不存在不抛错", () => {
    const ws = mkWorkspace();
    writeAgentTokenFile(ws, "sk_agent_x");
    removeAgentTokenFile(ws);
    expect(() => readFileSync(agentTokenFilePath(ws), "utf-8")).toThrow();
    expect(() => removeAgentTokenFile(ws)).not.toThrow();
  });
});

describe("loadAgentContext 的 SLOCK_AGENT_TOKEN_FILE 路径（O11）", () => {
  const base = { SLOCK_AGENT_ID: "agent-1", SLOCK_SERVER_URL: "http://localhost:3001" };

  it("TOKEN_FILE 指向的文件内容作为 token（legacy-machine/file source）", () => {
    const ws = mkWorkspace();
    const f = join(ws, "token.txt");
    writeFileSync(f, "  sk_agent_from_file\n");
    const ctx = loadAgentContext({ ...base, SLOCK_AGENT_TOKEN_FILE: f });
    expect(ctx.token).toBe("sk_agent_from_file"); // trim 生效
    expect(ctx.secretSource).toBe("legacy-token-file");
  });

  it("TOKEN_FILE 优先于 SLOCK_AGENT_TOKEN 字面量", () => {
    const ws = mkWorkspace();
    const f = join(ws, "token.txt");
    writeFileSync(f, "sk_agent_file_wins");
    const ctx = loadAgentContext({ ...base, SLOCK_AGENT_TOKEN_FILE: f, SLOCK_AGENT_TOKEN: "sk_agent_literal" });
    expect(ctx.token).toBe("sk_agent_file_wins");
  });

  it("文件不可读 → AgentBootstrapError(TOKEN_FILE_UNREADABLE)，不回退字面量", () => {
    expect(() =>
      loadAgentContext({ ...base, SLOCK_AGENT_TOKEN_FILE: join(mkWorkspace(), "nonexistent"), SLOCK_AGENT_TOKEN: "x" }),
    ).toThrowError(/could not be read/);
  });

  it("无 FILE 时字面量仍可（向后兼容 legacy-token-env）", () => {
    const ctx = loadAgentContext({ ...base, SLOCK_AGENT_TOKEN: "sk_agent_legacy" });
    expect(ctx.token).toBe("sk_agent_legacy");
    expect(ctx.secretSource).toBe("legacy-token-env");
  });
});
