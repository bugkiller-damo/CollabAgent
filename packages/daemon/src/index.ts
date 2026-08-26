#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonCore } from "./daemon-core.js";
import { mkdirPrivateSync } from "./private-dir.js";

/**
 * 单实例守卫：.slock/daemon.pid 里若躺着一个还活着的旧 daemon，先整树杀掉再
 * 启动。防的是 supervisor watch 重启 / 手动重复启动留下的孤儿实例——两个
 * daemon 并存会把每个 agent 重复 spawn（双倍 token），且新实例签发的 scoped
 * token 会把旧实例 PTY 的 token 吊销（旧 MCP 调用全部 401）。
 * （2026-07-29 实测事故，见 supervisor.ts killTree 注释。）
 */
function enforceSingleInstance(): void {
  const slockDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".slock");
  const pidFile = join(slockDir, "daemon.pid");
  try {
    mkdirPrivateSync(slockDir);
    if (existsSync(pidFile)) {
      const oldPid = Number(readFileSync(pidFile, "utf-8").trim());
      if (oldPid && oldPid !== process.pid) {
        let alive = false;
        try {
          process.kill(oldPid, 0);
          alive = true;
        } catch {
          /* 不存在 */
        }
        if (alive) {
          console.log(`[Daemon] Another daemon instance (pid ${oldPid}) is alive — killing it before start`);
          if (process.platform === "win32") {
            try {
              spawn("taskkill", ["/pid", String(oldPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            } catch {
              try {
                process.kill(oldPid);
              } catch {
                /* ignore */
              }
            }
          } else {
            try {
              process.kill(oldPid, "SIGTERM");
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    writeFileSync(pidFile, String(process.pid));
  } catch (err) {
    console.warn("[Daemon] single-instance lock failed (best-effort):", err instanceof Error ? err.message : err);
  }
}

enforceSingleInstance();

function parseArgs(args: string[]): { serverUrl: string; apiKey: string } | null {
  let serverUrl = "";
  let apiKey = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
    if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i];
  }
  if (!serverUrl || !apiKey) return null;
  return { serverUrl, apiKey };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error("Usage: collabagent-daemon --server-url <url> --api-key <key>");
  process.exit(1);
}

const daemon = new DaemonCore(parsed);

const main = async () => {
  try {
    await daemon.start();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
};
void main();

const shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
