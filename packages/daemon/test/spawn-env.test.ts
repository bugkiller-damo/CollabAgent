import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPtyEnv, writeMcpConfig } from "../src/agent-runtime-spawn.js";

// O11：子进程边界的凭据脱敏——PTY env 不含明文 token；.mcp.json 只含 token 文件路径
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("buildPtyEnv（O11 脱敏）", () => {
  it("剥离 SLOCK_AGENT_TOKEN，保留 SLOCK_AGENT_TOKEN_FILE 等非敏感项", () => {
    const env = buildPtyEnv({
      SLOCK_AGENT_ID: "agent-1",
      SLOCK_AGENT_TOKEN: "sk_agent_secret",
      SLOCK_AGENT_TOKEN_FILE: "/tmp/ws/.slock/agent-token",
      SLOCK_SERVER_URL: "http://localhost:3001",
      PATH: "/usr/bin",
    });
    expect(env.SLOCK_AGENT_TOKEN).toBeUndefined();
    expect(env.SLOCK_AGENT_TOKEN_FILE).toBe("/tmp/ws/.slock/agent-token");
    expect(env.SLOCK_AGENT_ID).toBe("agent-1");
    expect(env.PATH).toBe("/usr/bin");
    // PTY 渲染必需项不受影响
    expect(env.TERM).toBe("xterm-256color");
    expect(env.FORCE_COLOR).toBe("1");
  });

  it("不改动入参对象（纯函数语义）", () => {
    const base = { SLOCK_AGENT_TOKEN: "sk_agent_secret" };
    buildPtyEnv(base);
    expect(base.SLOCK_AGENT_TOKEN).toBe("sk_agent_secret");
  });
});

describe("writeMcpConfig（O11）", () => {
  it(".mcp.json 含 SLOCK_AGENT_TOKEN_FILE 路径，无任何明文 token", () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-mcpcfg-"));
    tmpDirs.push(ws);
    writeMcpConfig(ws, "agent-1", "/tmp/ws/.slock/agent-token", "http://localhost:3001", "/tmp/bundle.cjs");
    const raw = readFileSync(join(ws, ".mcp.json"), "utf-8");
    const cfg = JSON.parse(raw);
    const env = cfg.mcpServers.slock.env;
    expect(env.SLOCK_AGENT_TOKEN_FILE).toBe("/tmp/ws/.slock/agent-token");
    expect(env.SLOCK_AGENT_TOKEN).toBeUndefined();
    expect(env.SLOCK_AGENT_ID).toBe("agent-1");
    expect(raw).not.toContain("sk_agent_");
  });

  it("settings.local.json 写入 enableAllProjectMcpServers（MCP 信任免弹窗，回归保护）", () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-mcpcfg-"));
    tmpDirs.push(ws);
    writeMcpConfig(ws, "agent-1", "/f", "http://x", "/b.cjs");
    const settings = JSON.parse(readFileSync(join(ws, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });
});
