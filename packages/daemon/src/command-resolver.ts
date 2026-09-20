import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { resolveCommandOnPath } from "./drivers/probe.js";

/**
 * 跨平台命令解析器。
 *
 * Windows: PATH 用 `;` 分隔 + PATHEXT 后缀（.cmd/.bat/.exe）
 * POSIX:   PATH 用 `:` 分隔，无后缀
 */

const WINDOWS_EXTS = [".cmd", ".bat", ".exe", ".com"];

const WINDOWS_KNOWN_PATHS: Record<string, string[]> = {
  claude: ["C:/Program Files/Claude Code/claude.cmd", "C:/Program Files (x86)/Claude Code/claude.cmd"],
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
  return ext
    .split(";")
    .map((e) => e.toLowerCase())
    .filter(Boolean);
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

/**
 * 解析 .cmd shim 真正 exec 的 .exe（原 agent-runtime.ts 私有实现，A1.2 迁出共用）。
 *
 * Windows 上的 npm 全局安装会创建 `claude.cmd` shim（实质是 batch 包装器），
 * node-pty 的 ConPTY 后端在调用 CreateProcessW 时不会沿 PATH 查找 .cmd，
 * 会直接报 ERROR_FILE_NOT_FOUND (code 2)。
 *
 * 解法：先用 `where` / 已知的 npm 路径找到 .cmd/.exe 的真实绝对路径。
 * 若找到的是 .cmd shim，进一步解析其内容，定位它真正 exec 的 .exe，
 * 避免 ConPTY 多走一层 cmd.exe 解释（也避免奇怪的路径传递问题）。
 */
const resolveCmdShimTarget = (cmdPath: string): string | null => {
  try {
    const content = readFileSync(cmdPath, "utf-8");
    // .cmd shim 通常长这样：
    //   @"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
    // 提取引号内的 .exe 路径
    const m = content.match(/^[^"]*?"([^"]+\.exe)"/m);
    if (m) {
      const raw = m[1];
      // 把 %dp0% 替换为 .cmd 所在目录
      const resolved = raw.replace(/%~dp0%|%dp0%/gi, dirname(cmdPath));
      if (existsSync(resolved)) return resolved;
      // 也有可能 %dp0% 已展开（绝对路径）
      if (existsSync(raw)) return raw;
    }
  } catch {
    /* 解析失败，回退 */
  }
  return null;
};

/**
 * A1.2：三处 spawn（PTY / PersistentClaude / claudePrint）共用的 Claude 可执行
 * 文件解析。跨平台：probe 的 where/which + .cmd shim 解包 + command-resolver
 * 通用兜底。返回 "claude" 裸名字表示未解析到（由 spawn 侧按平台决定走不走 shell）。
 */
export const resolveClaudeBinary = (): string => {
  const fromProbe = resolveCommandOnPath("claude");
  if (fromProbe) {
    if (/\.(cmd|bat)$/i.test(fromProbe)) {
      const realExe = resolveCmdShimTarget(fromProbe);
      if (realExe) return realExe;
      // 同目录替换（极少数情况 shim 与 exe 同目录）
      const sameDirExe = fromProbe.replace(/\.(cmd|bat)$/i, ".exe");
      if (existsSync(sameDirExe)) return sameDirExe;
    }
    return fromProbe;
  }
  // 最后兜底：用 command-resolver 的通用搜索
  const fallback = resolveCommand("claude");
  if (existsSync(fallback)) return fallback;
  return "claude";
};
