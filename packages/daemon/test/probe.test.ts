import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();
const existsSync = vi.fn();

vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, existsSync };
});

const { probeBinary, probeClaude, probeRuntimes } = await import("../src/drivers/probe.js");

afterEach(() => {
  execFileSync.mockReset();
  existsSync.mockReset();
});

describe("probeBinary", () => {
  it("未找到命令 → unavailable", () => {
    existsSync.mockReturnValue(false);
    execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(probeBinary("codex")).toEqual({ available: false });
  });

  it("where 命中后读 --version", () => {
    existsSync.mockReturnValue(false);
    execFileSync.mockImplementation((cmd: string) => {
      if (cmd === "where") return "C:/bin/claude.exe\n";
      return "1.2.3\n";
    });
    expect(probeClaude()).toEqual({ available: true, version: "1.2.3" });
  });
});

describe("probeRuntimes", () => {
  it("四格都列出；未装 = not_installed；claude 已装 = installed；其它已装 = installed_unsupported", () => {
    existsSync.mockImplementation((p: unknown) => {
      const s = String(p).replace(/\\/g, "/");
      return /\/(claude|codex)(\.cmd)?$/.test(s);
    });
    execFileSync.mockImplementation((cmd: string) => {
      if (cmd === "where" || cmd === "which") throw new Error("missing");
      if (typeof cmd === "string" && (cmd.includes("claude") || cmd.includes("codex"))) return "9.9.9";
      throw new Error("missing");
    });
    const map = Object.fromEntries(probeRuntimes().map((r) => [r.id, r]));
    expect(Object.keys(map).sort()).toEqual(["claude", "codex", "gemini", "opencode"]);
    expect(map.claude).toMatchObject({ status: "installed", version: "9.9.9" });
    expect(map.codex).toMatchObject({ status: "installed_unsupported", version: "9.9.9" });
    expect(map.gemini?.status).toBe("not_installed");
    expect(map.opencode?.status).toBe("not_installed");
  });
});
