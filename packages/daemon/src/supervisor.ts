#!/usr/bin/env node
// Daemon 监督进程：文件变更自动重启（dev watch）+ 崩溃自动重启（带退避）+ 干净关闭。
// 用法与 daemon 相同，参数透传：
//   pnpm --filter daemon dev -- --server-url http://localhost:3001 --api-key sk_machine_xxx
// 直接跑单次（不监督）用 `dev:once`。
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
const entry = join(srcDir, "index.ts");
// 「计划内重启」标记：watch 触发重启前写给 daemon——它不是崩溃，下次启动不应
// 触发 autostart 崩溃恢复（否则每次改代码热重启都会把所有活跃 agent 拉起一遍，
// 2026-07-18 实测：supervisor 重启后 agent 未被提问就自动 spawn）。
const plannedRestartMarker = join(srcDir, "..", ".slock", "planned-restart");
const passthrough = process.argv.slice(2);
const q = (a: string) => (/\s/.test(a) ? `"${a}"` : a);

let child: ChildProcess | null = null;
let shuttingDown = false;
let expectRestart = false;          // true 表示是我们主动重启（watch/手动），非崩溃
let restartTimes: number[] = [];     // 崩溃时间窗，用于退避
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let watchDebounce: ReturnType<typeof setTimeout> | null = null;

/**
 * 整树杀 daemon 子进程。Windows 上 child 是 shell:true 包出来的 cmd 包装层，
 * child.kill() 只杀 cmd，真正的 node/tsx 孙子进程变孤儿继续跑——
 * 2026-07-29 实测后果：新旧两个 daemon 并存（日志全双份）、agent 被重复
 * spawn（双倍 token）、旧 PTY 的 scoped token 被新 spawn 吊销（MCP 401）。
 * taskkill /T 把 cmd + node + 其下所有 agent PTY 整棵树拔掉。
 */
function killTree(c: ChildProcess): void {
  if (c.pid == null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    } catch { /* fall through to plain kill */ }
  }
  try { c.kill(); } catch { /* already dead */ }
}

function startChild(): void {
  const cmd = `npx tsx ${q(entry)} ${passthrough.map(q).join(" ")}`.trim();
  console.log("[Supervisor] starting daemon…");
  child = spawn(cmd, { stdio: "inherit", shell: true, windowsHide: true });
  child.on("exit", (code, signal) => {
    child = null;
    if (shuttingDown) return;
    if (expectRestart) { expectRestart = false; startChild(); return; } // 主动重启：立即拉起
    // 崩溃：1 分钟内 >5 次则退避到 30s，否则 1s
    const now = Date.now();
    restartTimes = restartTimes.filter((t) => now - t < 60000);
    restartTimes.push(now);
    const delay = restartTimes.length > 5 ? 30000 : 1000;
    console.warn(`[Supervisor] daemon exited (code=${code} signal=${signal}); restarting in ${delay}ms`);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { restartTimer = null; if (!shuttingDown) startChild(); }, delay);
  });
}

function restartForChange(file: string): void {
  console.log(`[Supervisor] change detected (${file}), restarting daemon…`);
  if (child) {
    expectRestart = true;
    // 写「计划内重启」标记：daemon 下次启动看到它就不跑 autostart
    try {
      mkdirSync(join(srcDir, "..", ".slock"), { recursive: true });
      writeFileSync(plannedRestartMarker, String(Date.now()));
    } catch { /* best-effort */ }
    killTree(child);
  }
  else startChild();
}

// 文件监听（dev）：src 下的 .ts 变更触发重启；忽略生成物
try {
  watch(srcDir, { recursive: true }, (_evt, file) => {
    if (!file) return;
    const f = String(file);
    if (!f.endsWith(".ts")) return;
    if (f.includes(".slock") || f.includes("node_modules")) return;
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => restartForChange(f), 300);
  });
  console.log("[Supervisor] watching src/ for changes");
} catch (err: any) {
  console.warn("[Supervisor] file watch unavailable:", err?.message);
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child) killTree(child);
  console.log("[Supervisor] shutting down");
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startChild();
