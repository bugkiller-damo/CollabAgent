import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { agentWorkspacePath } from "./agent-startup.js";

/** 单文件上限：防 MEMORY.md 膨胀把 WS/HTTP 打爆 */
export const WORKSPACE_MAX_BYTES = 256 * 1024;
const MAX_LIST = 80;

export interface WorkspaceFileMeta {
  path: string;
  bytes: number;
  mtime: string;
}

export interface WorkspaceListing {
  exists: boolean;
  files: WorkspaceFileMeta[];
}

export type WorkspaceReadResult =
  | { ok: true; path: string; content: string; bytes: number }
  | { ok: false; error: string };

function posixRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/**
 * 人类可读工作区白名单：MEMORY.md、其它顶层 .md（不含 CLAUDE.md）、notes/**。
 * 拒绝密钥目录、点文件、路径穿越。
 */
export function isAllowedWorkspaceRel(rel: string): boolean {
  const n = posixRel(rel).replace(/^\/+/, "");
  if (!n || n.includes("\0") || n.includes("..")) return false;
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return false;
  const parts = n.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p.startsWith(".") || p === "node_modules")) return false;
  if (n === "MEMORY.md") return true;
  if (n === "CLAUDE.md") return false;
  if (parts[0] === "notes") return true;
  if (parts.length === 1 && n.toLowerCase().endsWith(".md")) return true;
  return false;
}

function resolveInsideWorkspace(root: string, rel: string): string | null {
  if (!isAllowedWorkspaceRel(rel)) return null;
  const abs = join(root, ...posixRel(rel).split("/"));
  const relBack = relative(root, abs);
  if (!relBack || relBack.startsWith("..") || relBack.startsWith(`..${sep}`)) return null;
  return abs;
}

function collectFiles(dir: string, prefix: string, out: WorkspaceFileMeta[]): void {
  if (out.length >= MAX_LIST) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  entries.sort((a, b) => a.localeCompare(b));
  for (const name of entries) {
    if (out.length >= MAX_LIST) return;
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st: Stats;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (isAllowedWorkspaceRel(rel) || rel === "notes") collectFiles(abs, rel, out);
      continue;
    }
    if (!st.isFile() || !isAllowedWorkspaceRel(rel)) continue;
    out.push({ path: rel, bytes: st.size, mtime: st.mtime.toISOString() });
  }
}

export function listWorkspaceFiles(agentName: string): WorkspaceListing {
  const root = agentWorkspacePath(agentName);
  if (!existsSync(root)) return { exists: false, files: [] };
  const files: WorkspaceFileMeta[] = [];
  collectFiles(root, "", files);
  files.sort((a, b) => {
    if (a.path === "MEMORY.md") return -1;
    if (b.path === "MEMORY.md") return 1;
    return a.path.localeCompare(b.path);
  });
  return { exists: true, files };
}

export function readWorkspaceFile(agentName: string, rel: string): WorkspaceReadResult {
  if (!isAllowedWorkspaceRel(rel)) return { ok: false, error: "path not allowed" };
  const root = agentWorkspacePath(agentName);
  const abs = resolveInsideWorkspace(root, rel);
  if (!abs) return { ok: false, error: "path not allowed" };
  if (!existsSync(abs)) return { ok: false, error: "not found" };
  let st: Stats;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, error: "not found" };
  }
  if (!st.isFile()) return { ok: false, error: "not a file" };
  if (st.size > WORKSPACE_MAX_BYTES) return { ok: false, error: "file too large" };
  try {
    const buf = readFileSync(abs);
    if (buf.includes(0)) return { ok: false, error: "binary file" };
    return { ok: true, path: posixRel(rel), content: buf.toString("utf-8"), bytes: buf.length };
  } catch {
    return { ok: false, error: "read failed" };
  }
}
