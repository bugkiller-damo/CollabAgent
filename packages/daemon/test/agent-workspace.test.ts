import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeAgentDirName } from "../src/agent-dir-name.js";
import { agentWorkspacePath } from "../src/agent-startup.js";
import { isAllowedWorkspaceRel, listWorkspaceFiles, readWorkspaceFile } from "../src/agent-workspace.js";

const tmpRoots: string[] = [];
const origCwd = process.cwd();

function withWorkspace(agentName: string, files: Record<string, string>): string {
  const root = join(origCwd, ".slock", "workspaces", safeAgentDirName(agentName));
  mkdirSync(root, { recursive: true });
  tmpRoots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf-8");
  }
  return root;
}

afterEach(() => {
  while (tmpRoots.length) {
    rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

describe("isAllowedWorkspaceRel", () => {
  it("允许 MEMORY.md / 顶层 md / notes/**，拒绝密钥与穿越", () => {
    expect(isAllowedWorkspaceRel("MEMORY.md")).toBe(true);
    expect(isAllowedWorkspaceRel("scratch.md")).toBe(true);
    expect(isAllowedWorkspaceRel("notes/foo.md")).toBe(true);
    expect(isAllowedWorkspaceRel("notes/a/b.txt")).toBe(true);
    expect(isAllowedWorkspaceRel("CLAUDE.md")).toBe(false);
    expect(isAllowedWorkspaceRel(".mcp.json")).toBe(false);
    expect(isAllowedWorkspaceRel(".slock/agent-token")).toBe(false);
    expect(isAllowedWorkspaceRel("../MEMORY.md")).toBe(false);
    expect(isAllowedWorkspaceRel("notes/../.slock/agent-token")).toBe(false);
  });
});

describe("list/read workspace", () => {
  it("列出 MEMORY 与 notes，读内容；拒绝 CLAUDE 与不存在", () => {
    const name = "ws_reader_" + Date.now().toString(36);
    withWorkspace(name, {
      "MEMORY.md": "# mem\nhello",
      "CLAUDE.md": "secret prompt",
      "notes/todo.md": "- a",
      ".mcp.json": "{}",
    });
    const listing = listWorkspaceFiles(name);
    expect(listing.exists).toBe(true);
    expect(listing.files.map((f) => f.path)).toEqual(["MEMORY.md", "notes/todo.md"]);
    const mem = readWorkspaceFile(name, "MEMORY.md");
    expect(mem.ok).toBe(true);
    if (mem.ok) expect(mem.content).toContain("hello");
    expect(readWorkspaceFile(name, "CLAUDE.md").ok).toBe(false);
    expect(readWorkspaceFile(name, "missing.md").ok).toBe(false);
    expect(agentWorkspacePath(name).replace(/\\/g, "/")).toContain("/.slock/workspaces/");
  });

  it("工作区不存在时 exists=false", () => {
    expect(listWorkspaceFiles("no_such_agent_zzz")).toEqual({ exists: false, files: [] });
  });
});
