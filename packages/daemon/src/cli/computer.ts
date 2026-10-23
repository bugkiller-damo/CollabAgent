/**
 * `slock computer` —— daemon 本机生命周期命令面（raft-computer 式装机/启停）。
 *
 *   setup  /<name> --server-url <url> --api-key <sk_machine_...> [--machine <uuid>] [--state-dir <dir>]
 *   start  [/<name>]     前台拉起 supervisor（watch + 崩溃重启），单实例守卫防双开
 *   restart [/<name>]    stop + start；未运行 = 直接 start
 *   stop   [/<name>]     按 launcher.pid / daemon.pid 整树杀
 *   list                 已登记 server（token 恒脱敏）
 *   remove /<name>       删除登记
 *
 * 关键不变量：
 * - daemon 主链路零改动——start 只把 profile 翻译成 env（SLOCK_SERVER_URL /
 *   SLOCK_API_KEY / SLOCK_SERVER_NAME / SLOCK_MACHINE_ID / SLOCK_STATE_DIR）
 *   再 spawn supervisor；index.ts 的 env 回落与单实例守卫原样生效。
 * - launcher.pid 记的是 supervisor（或直跑 node）的 pid 而非 daemon pid——
 *   stop 必须杀 launcher，否则 supervisor 1s 内把 daemon 拉活；两个 supervisor
 *   并存会借 enforceSingleInstance 互杀对方 daemon 形成打地鼠（2026-07-29
 *   事故的变体，daemon.pid 守卫挡不住「launcher 层级」的重复）。
 * - start 以前台模式跑（stdio inherit，Ctrl-C 整树退）——detach/后台/log tail
 *   属于后续增量，先把「参数消失」做掉。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  type ComputerProfile,
  type ComputerProfiles,
  defaultComputerRegistryPath,
  loadComputerProfiles,
  normalizeServerName,
  removeComputerProfile,
  saveComputerProfile,
} from "../computer-registry.js";
import { emit, fail } from "../output.js";
import { mkdirPrivateSync } from "../private-dir.js";
import { redactSecrets } from "../redact.js";

const LAUNCHER_PID_FILE = "computer-launcher.pid";
const DAEMON_PID_FILE = "daemon.pid";
const DAEMON_PACKAGE_NAME = "@collabagent/daemon";

/* ------------------------------ 路径 / 进程基元 ------------------------------ */

/** 向上找名字为 @collabagent/daemon 的 package.json（cli.ts 在 src/cli 下两级） */
function findDaemonRootUp(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg?.name === DAEMON_PACKAGE_NAME) return dir;
    } catch {
      /* 没有/不可读 → 继续向上 */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * daemon 包根解析：SLOCK_DAEMON_ROOT > import.meta.url（tsx 直跑）>
 * argv[1]（bundle 落在 <stateDir>/slock-cli.cjs 时，上级目录恰是包根的常见布局）>
 * setup 时存进 profile 的 daemonRoot。
 */
export function resolveDaemonRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SLOCK_DAEMON_ROOT?.trim();
  if (override && existsSync(join(override, "package.json"))) return resolve(override);
  const seeds: string[] = [];
  try {
    if (import.meta.url) seeds.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* esbuild cjs bundle 下 import.meta 为空对象 */
  }
  if (process.argv[1]) seeds.push(dirname(resolve(process.argv[1])));
  for (const seed of seeds) {
    const root = findDaemonRootUp(seed);
    if (root) return root;
  }
  return null;
}

const readPidFile = (path: string): number | null => {
  try {
    const pid = Number(readFileSync(path, "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权信号（视为活着）；ESRCH 才是真死
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
};

/** 同步整树杀（CLI 语境不需要 async 等死透——taskkill /T /F 本身就阻塞到树亡） */
export const killPidTree = (pid: number): void => {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* taskkill 不可用 → 退 kill */
      try {
        process.kill(pid);
      } catch {
        /* already dead */
      }
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already dead */
  }
};

/* ------------------------------ profile 解析 ------------------------------ */

export interface ComputerDeps {
  /** 测试注入：servers.json 路径；缺省 ~/.slock/servers.json */
  registryPath?: string;
  /** 测试注入：daemon 包根；缺省 resolveDaemonRoot() */
  daemonRoot?: string | null;
}

/** 名字定位：显式 /<name> > 唯一登记自动当选；缺失给可执行的下一步提示 */
export function resolveComputerTarget(
  argName: string | undefined,
  profiles: ComputerProfiles,
): { name: string; profile: ComputerProfile } {
  const name = normalizeServerName(argName);
  if (name) {
    const profile = profiles[name];
    if (!profile) {
      fail(
        "server-not-enrolled",
        `no profile for "${name}" — enroll first: slock computer setup /${name} --server-url <url> --api-key <key>`,
      );
    }
    return { name, profile };
  }
  const names = Object.keys(profiles);
  if (names.length === 0) {
    fail(
      "no-servers-enrolled",
      "no servers enrolled — run: slock computer setup /<name> --server-url <url> --api-key <key>",
    );
  }
  if (names.length > 1) {
    fail("server-name-required", `multiple servers enrolled (${names.join(", ")}) — specify /<name>`);
  }
  const only = names[0]!;
  return { name: only, profile: profiles[only]! };
}

const resolveStateDir = (profile: ComputerProfile, daemonRoot: string): string =>
  profile.stateDir ?? join(daemonRoot, ".slock");

const rootFor = (profile: ComputerProfile, deps?: ComputerDeps): string => {
  const root = deps?.daemonRoot ?? resolveDaemonRoot() ?? profile.daemonRoot;
  if (!root) {
    fail(
      "daemon-root-unknown",
      "cannot locate daemon package root — re-run `slock computer setup` or set SLOCK_DAEMON_ROOT",
    );
  }
  return root;
};

/* ------------------------------ ops（可测试面） ------------------------------ */

export interface SetupOptions {
  serverUrl?: string;
  apiKey?: string;
  machine?: string;
  stateDir?: string;
}

export function computerSetup(argName: string, opts: SetupOptions, deps?: ComputerDeps) {
  const name = normalizeServerName(argName);
  if (!name) fail("server-name-required", "usage: slock computer setup /<name> --server-url <url> --api-key <key>");
  const serverUrl = opts.serverUrl?.trim() ?? "";
  if (!serverUrl) fail("server-url-required", "--server-url is required");
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    fail("server-url-invalid", `--server-url is not a valid URL: ${serverUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("server-url-invalid", `--server-url must be http(s): ${serverUrl}`);
  }
  const apiKey = opts.apiKey?.trim() ?? "";
  if (!apiKey) fail("api-key-required", "--api-key is required (sk_machine_ token from web /computers)");

  const registryPath = deps?.registryPath ?? defaultComputerRegistryPath();
  const daemonRoot = deps?.daemonRoot ?? resolveDaemonRoot();
  const profile: ComputerProfile = {
    serverUrl,
    apiKey,
    ...(opts.machine?.trim() ? { machineUuid: opts.machine.trim() } : {}),
    ...(opts.stateDir?.trim() ? { stateDir: resolve(opts.stateDir.trim()) } : {}),
    ...(daemonRoot ? { daemonRoot } : {}),
    enrolledAt: new Date().toISOString(),
  };
  saveComputerProfile(name, profile, registryPath);
  return {
    ok: true,
    data: {
      name,
      serverUrl,
      apiKey: redactSecrets(apiKey),
      registryPath,
      enrolled: true,
      next: `slock computer start /${name}`,
    },
  };
}

export function computerList(deps?: ComputerDeps) {
  const registryPath = deps?.registryPath ?? defaultComputerRegistryPath();
  const profiles = loadComputerProfiles(registryPath);
  return {
    ok: true,
    data: {
      registryPath,
      servers: Object.entries(profiles).map(([name, p]) => ({
        name,
        serverUrl: p.serverUrl,
        apiKey: redactSecrets(p.apiKey),
        ...(p.machineUuid ? { machineUuid: p.machineUuid } : {}),
        ...(p.stateDir ? { stateDir: p.stateDir } : {}),
        enrolledAt: p.enrolledAt,
      })),
    },
  };
}

export function computerRemove(argName: string, deps?: ComputerDeps) {
  const name = normalizeServerName(argName);
  if (!name) fail("server-name-required", "usage: slock computer remove /<name>");
  const registryPath = deps?.registryPath ?? defaultComputerRegistryPath();
  const removed = removeComputerProfile(name, registryPath);
  if (!removed) fail("server-not-enrolled", `no profile for "${name}"`);
  return { ok: true, data: { name, removed } };
}

/**
 * 停掉本登记名下的 launcher + daemon（若各自 pidfile 指向活进程）。
 * 返回结构化结果；什么都不在跑也 ok（幂等——restart 语义依赖这一点）。
 */
export function computerStop(argName: string | undefined, deps?: ComputerDeps) {
  const profiles = loadComputerProfiles(deps?.registryPath);
  const { name, profile } = resolveComputerTarget(argName, profiles);
  const root = deps?.daemonRoot ?? resolveDaemonRoot() ?? profile.daemonRoot;
  const stateDir = root ? resolveStateDir(profile, root) : null;
  const killed: string[] = [];
  const skipped: string[] = [];
  if (!stateDir) {
    return { ok: true, data: { name, killed, note: "state-dir unknown — nothing to stop" } };
  }
  for (const [label, file] of [
    ["launcher", LAUNCHER_PID_FILE],
    ["daemon", DAEMON_PID_FILE],
  ] as const) {
    const pidPath = join(stateDir, file);
    const pid = readPidFile(pidPath);
    if (pid && pidAlive(pid)) {
      killPidTree(pid);
      killed.push(`${label}:${pid}`);
      if (label === "daemon" && !killed.some((k) => k.startsWith("launcher"))) {
        skipped.push("daemon had no live launcher — if it was started by other means its supervisor may respawn it");
      }
    } else {
      skipped.push(`${label}: not running`);
    }
    if (label === "launcher") {
      try {
        rmSync(pidPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return { ok: true, data: { name, killed, note: skipped } };
}

/**
 * 前台启动：spawn supervisor（保留 watch + 崩溃重启）并把 launcher pid 落盘。
 * restart 语义由调用方先 computerStop 再进本函数保证——单实例守卫只能挡
 * daemon 层，挡不住 supervisor 层的「谁后写谁赢」。
 */
export async function computerStart(argName: string | undefined, deps?: ComputerDeps) {
  const profiles = loadComputerProfiles(deps?.registryPath);
  const { name, profile } = resolveComputerTarget(argName, profiles);
  const root = rootFor(profile, deps);
  const stateDir = resolveStateDir(profile, root);
  const launcherPidPath = join(stateDir, LAUNCHER_PID_FILE);

  const running = readPidFile(launcherPidPath);
  if (running && pidAlive(running)) {
    return {
      ok: true,
      data: {
        name,
        alreadyRunning: true,
        attached: false,
        launcherPid: running,
        hint: `slock computer restart /${name}`,
      },
    };
  }

  const supervisorEntry = join(root, "src", "supervisor.ts");
  const distEntry = join(root, "dist", "index.js");
  let cmd: string;
  let mode: string;
  if (existsSync(supervisorEntry)) {
    cmd = `npx tsx "${supervisorEntry}"`;
    mode = "supervisor+tsx";
  } else if (existsSync(distEntry)) {
    cmd = `"${process.execPath}" "${distEntry}"`;
    mode = "dist (no supervisor)";
  } else {
    fail("daemon-entry-missing", `neither ${supervisorEntry} nor ${distEntry} exists — run pnpm build or setup again`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SLOCK_SERVER_URL: profile.serverUrl,
    SLOCK_API_KEY: profile.apiKey,
    SLOCK_SERVER_NAME: name,
    ...(profile.machineUuid ? { SLOCK_MACHINE_ID: profile.machineUuid } : {}),
    ...(profile.stateDir ? { SLOCK_STATE_DIR: profile.stateDir } : {}),
  };

  mkdirPrivateSync(stateDir);
  const child: ChildProcess = spawn(cmd, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  });
  if (child.pid) writeFileSync(launcherPidPath, String(child.pid));
  emit({ ok: true, data: { name, launcherPid: child.pid ?? null, mode, stateDir } });

  // 前台守候：我们的信号 = 整树关停（supervisor 自身有优雅关闭，SIGTERM 即可）
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    if (child.pid) killPidTree(child.pid);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const exitCode = await new Promise<number>((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code ?? 0));
    child.once("error", () => resolvePromise(1));
  });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  try {
    rmSync(launcherPidPath, { force: true });
  } catch {
    /* best-effort */
  }
  return { ok: exitCode === 0, data: { name, attached: true, exitCode, stoppedBySignal: stopping } };
}

/* ------------------------------ commander 接线 ------------------------------ */

export function registerComputer(parent: Command) {
  parent
    .command("setup <name>")
    .description("Enroll this machine to a server (persisted to ~/.slock/servers.json)")
    .requiredOption("--server-url <url>", "server base URL, e.g. http://localhost:3001")
    .requiredOption("--api-key <key>", "sk_machine_ token from web /computers")
    .option("--machine <uuid>", "pin machine identity (SLOCK_MACHINE_ID)")
    .option("--state-dir <dir>", "pin SLOCK_STATE_DIR (default: <daemonRoot>/.slock)")
    .action((name: string, o: SetupOptions) => emit(computerSetup(name, o)));

  parent
    .command("list")
    .description("List enrolled servers (tokens redacted)")
    .action(() => emit(computerList()));

  parent
    .command("remove <name>")
    .description("Remove an enrolled server profile")
    .action((name: string) => emit(computerRemove(name)));

  parent
    .command("start [name]")
    .description("Start the daemon for an enrolled server (foreground; /<name> or bare name)")
    .action(async (name?: string) => {
      const r = await computerStart(name);
      if (!r.data.attached) emit(r); // 前台路径 spawn 时已 emit；早退/失败在此补输出
      if (!r.ok) process.exitCode = 1;
    });

  parent
    .command("restart [name]")
    .description("Restart the daemon (not running = plain start)")
    .action(async (name?: string) => {
      computerStop(name); // 幂等：没在跑也 ok
      const r = await computerStart(name);
      if (!r.data.attached) emit(r);
      if (!r.ok) process.exitCode = 1;
    });

  parent
    .command("stop [name]")
    .description("Stop the daemon (kill launcher + daemon process tree)")
    .action((name?: string) => emit(computerStop(name)));
}
