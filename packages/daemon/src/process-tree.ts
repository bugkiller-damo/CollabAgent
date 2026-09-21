/**
 * Phase 5 §15：进程树终止。
 *
 * `child.kill()` 只杀直接子进程——worker 自己 spawn 的 MCP server / 子代理等
 * 孙进程会变孤儿泄漏。这里按平台收口整树终止：
 *
 * - POSIX：worker 以 `detached:true` spawn（成为新进程组的 leader），
 *   `process.kill(-pid, sig)` 打到整个组——worker 与全部孙进程一起收。
 *   组杀失败（ESRCH=组已不存在 / EPERM）回退单进程 kill。
 * - Windows：无 POSIX 信号/进程组，`taskkill /PID <pid> /T` 终止整棵进程树；
 *   强制档追加 /F（否则只对可响应 WM_CLOSE 的进程生效）。taskkill 失败
 *   （进程已死 / 工具缺失）回退 proc.kill()。
 *
 * 纪律：调用方负责先 detach 监听、再调本函数；本函数不触碰 Node 侧状态。
 */

import { type ChildProcess, spawnSync } from "node:child_process";

/** spawn 选项：POSIX 需要 detached 建独立进程组，-pid 才能打到全组。 */
export const treeKillSpawnOptions = (): { detached?: boolean } =>
  process.platform === "win32" ? {} : { detached: true };

/**
 * 终止整棵进程树。graceful=false → POSIX SIGKILL / Windows taskkill /F；
 * graceful=true → POSIX SIGTERM / Windows taskkill /T（不带 /F，给孙进程
 * 留响应终止的机会）。进程已退出时静默返回。
 */
export const killProcessTree = (proc: ChildProcess, opts?: { force?: boolean }): void => {
  const pid = proc.pid;
  if (pid === undefined || pid === 0) {
    try {
      proc.kill(opts?.force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* 进程可能已退出 */
    }
    return;
  }
  const force = opts?.force === true;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    try {
      spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      /* taskkill 不可用 → 回退单进程 */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  // POSIX：进程组杀（worker spawn 时 detached:true → pid 即 pgid）
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    return;
  } catch {
    /* ESRCH=组已空 / EPERM → 回退单进程 */
  }
  try {
    proc.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    /* ignore */
  }
};
