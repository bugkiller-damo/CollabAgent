import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Agent 会话管理 - 捕获和恢复 sessionId。
 * 不同 CLI 存储会话文件的位置不同：
 * - claude: ~/.claude/projects/<mangled-workspace-abs-path>/{sessionId}.jsonl
 *   （**不是** `{workspace}/.claude/projects/`——Claude Code 把会话记录写在用户
 *   主目录下，按"当前工作目录的绝对路径"生成一个目录名，不是写进项目目录本身。
 *   目录名的生成规则是把绝对路径里每一个非字母数字字符原样替换成一个 `-`
 *   （字符对字符替换，不合并连续的特殊字符——比如 `D:\code\slock` 会变成
 *   `D--code-slock`：冒号和反斜杠各自贡献一个 `-`）。这条路径在实现时通过对比
 *   本机真实的 `~/.claude/projects/` 目录名和已知的项目绝对路径核实过，不是猜的。）
 * - codex: ~/.codex/sessions/{sessionId}.jsonl
 * - gemini: {workspace}/.gemini/tmp/{project}/...
 * - opencode: {workspace}/.opencode/sessions/{sessionId}.json
 *
 * 何时可删（O13）：captureSessionId 靠「扫文件系统里最新修改的会话文件」猜测
 * 当前 session——在 PTY/TUI 模式下没有更好的来源。删除条件：
 *   a) claude 在结构化输出里直接报告 session id（`--output-format stream-json`
 *      的 system init 事件就带 session_id——one-shot 与 PersistentClaude 路径
 *      已经在用它，本启发式只服务 PTY 路径）；
 *   b) 或输入/输出通道整体结构化后（见 post-start-input-writer.ts 头注）。
 * 已知脆弱点：多 PTY 同 workspace 并发时「最新 mtime」可能拿错会话。
 */

/** Claude Code 生成 `~/.claude/projects/` 子目录名的规则：见上方注释。 */
export function mangleClaudeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

const SESSION_PATTERNS: Record<string, (workspaceDir: string) => string[]> = {
  claude: (workspaceDir: string) =>
    listJsonlFiles(join(homedir(), ".claude", "projects", mangleClaudeProjectPath(resolve(workspaceDir)))),
  codex: () => listJsonlFiles(join(homedir(), ".codex", "sessions")),
  gemini: (workspaceDir: string) => listJsonlFiles(join(workspaceDir, ".gemini", "tmp")),
  opencode: (workspaceDir: string) => listJsonlFiles(join(workspaceDir, ".opencode", "sessions")),
};

function listJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive: true, encoding: "utf-8" })
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function extractSessionId(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || "";
  return base.replace(/\.(jsonl|json)$/, "");
}

/** 捕获最新 sessionId (最近修改的会话文件)。返回 null 表示未找到。 */
export function captureSessionId(cliName: string, workspaceDir: string): string | null {
  const pattern = SESSION_PATTERNS[cliName];
  if (!pattern) {
    console.warn(`[Sessions] Unknown CLI '${cliName}', cannot capture sessionId`);
    return null;
  }
  const files = pattern(workspaceDir);
  if (!files.length) return null;

  let latest = files[0]!;
  let latestMtime = 0;
  for (const f of files) {
    try {
      const s = statSync(f);
      if (s.mtimeMs > latestMtime) {
        latestMtime = s.mtimeMs;
        latest = f;
      }
    } catch {
      /* skip */
    }
  }
  return extractSessionId(latest);
}

/** 列出某个 CLI 的所有 sessionId */
export function listSessions(cliName: string, workspaceDir: string): string[] {
  const pattern = SESSION_PATTERNS[cliName];
  if (!pattern) return [];
  return pattern(workspaceDir).map(extractSessionId);
}

/** 验证 sessionId 格式 (UUID 或 hex string) */
export function isValidSessionId(id: string): boolean {
  return /^[0-9a-f-]{8,64}$/i.test(id);
}

/** 解析 session 文件，提取元数据 (如果文件可解析) */
export function readSessionMetadata(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
