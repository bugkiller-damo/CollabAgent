import { existsSync } from "node:fs";
import { join, delimiter, sep } from "node:path";

/**
 * 跨平台命令解析器。
 *
 * Windows: PATH 用 `;` 分隔 + PATHEXT 后缀（.cmd/.bat/.exe）
 * POSIX:   PATH 用 `:` 分隔，无后缀
 */

const WINDOWS_EXTS = [".cmd", ".bat", ".exe", ".com"];

const WINDOWS_KNOWN_PATHS: Record<string, string[]> = {
  claude: [
    "C:/Program Files/Claude Code/claude.cmd",
    "C:/Program Files (x86)/Claude Code/claude.cmd",
  ],
  codex: [],
  gemini: [],
  opencode: [],
};

export function getPathDirs(): string[] {
  const path = process.env.PATH || process.env.Path || "";
  return path.split(delimiter).filter(Boolean);
}

export function getPathExtensions(): string[] {
  const ext = process.env.PATHEXT || "";
  if (!ext) return [];
  return ext.split(";").map((e) => e.toLowerCase()).filter(Boolean);
}

export function findInDir(dir: string, name: string): string | null {
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;

  const base = name.replace(/\.(cmd|bat|exe|com|sh)$/i, "");
  for (const ext of WINDOWS_EXTS) {
    const candidate = join(dir, base + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function searchInPath(name: string): string | null {
  for (const dir of getPathDirs()) {
    const found = findInDir(dir, name);
    if (found) return found;
  }
  return null;
}

export function resolveCommand(name: string): string {
  if (name.includes("/") || name.includes(sep)) {
    if (existsSync(name)) return name;
    console.warn(`[CmdResolver] Command not found at: ${name}`);
    return name;
  }

  if (process.platform === "win32") {
    const known = WINDOWS_KNOWN_PATHS[name.toLowerCase()];
    if (known) {
      for (const p of known) {
        if (existsSync(p)) return p;
      }
    }
  }

  const fromPath = searchInPath(name);
  if (fromPath) return fromPath;

  console.warn(`[CmdResolver] Command '${name}' not resolved via PATH; relying on shell`);
  return name;
}

export function quoteForShell(cmd: string): string {
  if (/[\s"'`]/.test(cmd)) return `"${cmd.replace(/"/g, '\\"')}"`;
  return cmd;
}