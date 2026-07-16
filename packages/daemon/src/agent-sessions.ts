import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent 会话管理 - 捕获和恢复 sessionId。
 * 不同 CLI 存储会话文件的位置不同：
 * - claude: {workspace}/.claude/projects/STAR/{sessionId}.jsonl
 * - codex: ~/.codex/sessions/{sessionId}.jsonl
 * - gemini: {workspace}/.gemini/tmp/{project}/...
 * - opencode: {workspace}/.opencode/sessions/{sessionId}.json
 */

const SESSION_PATTERNS: Record<string, (workspaceDir: string) => string[]> = {
  claude: (workspaceDir: string) => listJsonlFiles(join(workspaceDir, ".claude", "projects")),
  codex: () => listJsonlFiles(join(process.env.HOME || "", ".codex", "sessions")),
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
    } catch { /* skip */ }
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