import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { RuntimeProbe } from "@collabagent/shared";
import { RUNTIME_CATALOG_IDS, WIRED_RUNTIME_IDS } from "@collabagent/shared";

export function resolveCommandOnPath(command: string): string | null {
  const appData = process.env.APPDATA || "C:/Users/" + (process.env.USERNAME || "Default") + "/AppData/Roaming";
  const winPaths = [
    appData + "/npm/" + command + ".cmd",
    appData + "/npm/" + command,
    "C:/Program Files/Claude Code/" + command + ".cmd",
    "C:/Users/" + (process.env.USERNAME || "Default") + "/AppData/Local/Programs/claude/" + command + ".cmd",
    "C:/Users/" + (process.env.USERNAME || "Default") + "/AppData/Roaming/npm/" + command + ".cmd",
    "C:/Users/" + (process.env.USERNAME || "Default") + "/AppData/Roaming/npm/" + command,
  ];
  for (const p of winPaths) {
    if (existsSync(p)) return p;
  }
  try {
    const result = execFileSync("where", [command], { encoding: "utf-8" });
    const lines = result.trim().split("\n");
    if (lines[0]) return lines[0].replace(/\\/g, "/");
  } catch {
    /* not on PATH */
  }
  try {
    const result = execFileSync("which", [command], { encoding: "utf-8" });
    const t = result.trim();
    if (t) return t.replace(/\\/g, "/");
  } catch {
    /* not available */
  }
  return null;
}

export function probeBinary(command: string): { available: boolean; version?: string } {
  const cmd = resolveCommandOnPath(command);
  if (!cmd) return { available: false };
  try {
    // Windows 的 .cmd/.bat 包装器无法用 execFileSync 直接 spawn（Node 18+ 抛 EINVAL），
    // 必须经 shell；命令路径用引号包裹以兼容含空格的安装目录。
    const isWrapper = /\.(cmd|bat)$/i.test(cmd);
    const version = isWrapper
      ? execFileSync(`"${cmd}"`, ["--version"], { encoding: "utf-8", shell: true }).trim()
      : execFileSync(cmd, ["--version"], { encoding: "utf-8" }).trim();
    return { available: true, version: version || "unknown" };
  } catch {
    return { available: false };
  }
}

export function probeClaude(): { available: boolean; version?: string } {
  return probeBinary("claude");
}

const WIRED = new Set<string>(WIRED_RUNTIME_IDS);

/** 四格能力地图：未装也列出；已装未接线标 installed_unsupported */
export function probeRuntimes(): RuntimeProbe[] {
  return RUNTIME_CATALOG_IDS.map((id) => {
    const { available, version } = probeBinary(id);
    if (!available) return { id, status: "not_installed" as const };
    if (!WIRED.has(id)) return { id, status: "installed_unsupported" as const, version };
    return { id, status: "installed" as const, version };
  });
}
