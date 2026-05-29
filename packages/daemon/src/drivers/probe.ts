import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function resolveCommandOnPath(command: string): string | null {
  const winPaths = [
    "C:/Program Files/Claude Code/" + command + ".cmd",
    "C:/Users/" + (process.env.USERNAME || "Default") + "/AppData/Local/Programs/claude/" + command + ".cmd",
    "C:/Users/" + (process.env.USERNAME || "Default") + "/AppData/Roaming/npm/" + command + ".cmd",
  ];
  for (const p of winPaths) {
    if (existsSync(p)) return p;
  }
  try {
    const result = execFileSync("where", [command], { encoding: "utf-8" });
    const lines = result.trim().split("\n");
    if (lines[0]) return lines[0].replace(/\\/g, "/");
  } catch { /* not on PATH */ }
  try {
    const result = execFileSync("which", [command], { encoding: "utf-8" });
    const t = result.trim();
    if (t) return t.replace(/\\/g, "/");
  } catch { /* not available */ }
  return null;
}

export function probeClaude(): { available: boolean; version?: string } {
  const cmd = resolveCommandOnPath("claude");
  if (!cmd) return { available: false };
  try {
    const version = execFileSync(cmd, ["--version"], { encoding: "utf-8" }).trim();
    return { available: true, version: version || "unknown" };
  } catch {
    return { available: false };
  }
}
