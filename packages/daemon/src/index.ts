#!/usr/bin/env node
import "./load-env.js"; // 必须是第一个 import——在任何模块读 process.env 前加载 .env
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonCore } from "./daemon-core.js";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";

/**
 * 单实例守卫：.slock/daemon.pid 里若躺着一个还活着的旧 daemon，先整树杀掉再
 * 启动。防的是 supervisor watch 重启 / 手动重复启动留下的孤儿实例——两个
 * daemon 并存会把每个 agent 重复 spawn（双倍 token），且新实例签发的 scoped
 * token 会把旧实例 PTY 的 token 吊销（旧 MCP 调用全部 401）。
 * （2026-07-29 实测事故，见 supervisor.ts killTree 注释。）
 */
function enforceSingleInstance(): void {
  const stateDir = slockDir();
  const pidFile = join(stateDir, "daemon.pid");
  try {
    mkdirPrivateSync(stateDir);
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
            // H8：spawnSync 阻塞到 taskkill 退出——树死透才继续，否则新 daemon
            // 写 pid/连 WS 时旧进程还在收尾（双 daemon 并存窗口）。
            try {
              spawnSync("taskkill", ["/pid", String(oldPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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
              // SIGTERM 是优雅退出，给它最多 3s；还活着再 SIGKILL。
              const deadline = Date.now() + 3000;
              while (Date.now() < deadline) {
                try {
                  process.kill(oldPid, 0);
                } catch {
                  break; // 已死
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
              }
              try {
                process.kill(oldPid, 0);
                process.kill(oldPid, "SIGKILL");
              } catch {
                /* 已退出 */
              }
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

function parseArgs(args: string[]): { serverUrl: string; apiKey: string; serverName?: string } | null {
  // CLI 优先；缺省回落 env（SLOCK_SERVER_URL / SLOCK_API_KEY / SLOCK_SERVER_NAME，
  // 可经 packages/daemon/.env 固化），`pnpm dev` 零参数即可起。
  let serverUrl = process.env.SLOCK_SERVER_URL ?? "";
  let apiKey = process.env.SLOCK_API_KEY ?? "";
  let serverName = process.env.SLOCK_SERVER_NAME ?? "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
    if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i];
    // 2026-09-19：声明本进程服务的 server——服务端握手时与令牌 scope 比对，
    // 不一致直接拒连（拿错 token 立刻报，不静默连错 server）
    if (args[i] === "--server" && args[i + 1]) serverName = args[++i];
  }
  if (!serverUrl || !apiKey) return null;
  return { serverUrl, apiKey, ...(serverName.trim() ? { serverName: serverName.trim() } : {}) };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error(
    "Usage: collabagent-daemon --server-url <url> --api-key <key> [--server <name>]" +
      "  (或经 env/.env: SLOCK_SERVER_URL / SLOCK_API_KEY / SLOCK_SERVER_NAME)",
  );
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
