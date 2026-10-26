/**
 * `slock computer` —— daemon 本机生命周期命令面（raft-computer 式装机/启停）。
 *
 *   setup  /<name> --server-url <url> --api-key <sk_machine_...> [--machine <uuid>] [--state-dir <dir>]
 *   start  [/<name>] [--detach]   前台拉起（默认）；--detach 后台：日志落 <stateDir>/daemon.log，
 *                                 经内部 _run 拉起循环 spawn（崩溃自动重启，补 supervisor 缺口）
 *   restart [/<name>] [--detach]  stop + start；未运行 = 直接 start
 *   stop   [/<name>]              按 launcher.pid / daemon.pid 整树杀
 *   status [/<name>]              launcher/daemon pid 活性 + autostart 注册状态
 *   logs   [/<name>] [-n <N>]     tail <stateDir>/daemon.log（默认 50 行）
 *   install/uninstall [/<name>]   登录自启注册/移除（schtasks / launchd / systemd --user）
 *   list                          已登记 server（token 恒脱敏）
 *   remove /<name>                删除登记
 *   _run <name>                   （内部）--detach 的拉起循环，勿手调
 *
 * 关键不变量：
 * - daemon 主链路零改动——start/_run 只把 profile 翻译成 env（SLOCK_SERVER_URL /
 *   SLOCK_API_KEY / SLOCK_SERVER_NAME / SLOCK_MACHINE_ID / SLOCK_STATE_DIR /
 *   SLOCK_DAEMON_ROOT）再 spawn；index.ts 的 env 回落与单实例守卫原样生效。
 * - launcher.pid 记的是 supervisor/_run 的 pid 而非 daemon pid——stop 必须杀
 *   launcher，否则拉起循环 1s 内把 daemon 拉活；两个 launcher 并存会借
 *   enforceSingleInstance 互杀对方 daemon 形成打地鼠（2026-07-29 事故的变体，
 *   daemon.pid 守卫挡不住「launcher 层级」的重复）。
 * - detach 一律经 _run：bundle 布局没有 supervisor，没有循环就是「崩了没人管」；
 *   有 supervisor 的布局 _run 只是多一层兜底（supervisor 全退才接管），语义一致。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
import { findDistAsset } from "../dist-assets.js";
import { emit, fail } from "../output.js";
import { mkdirPrivateSync } from "../private-dir.js";
import { redactSecrets } from "../redact.js";
import { autostartInstalled, installAutostart, removeAutostart } from "./computer-autostart.js";

const LAUNCHER_PID_FILE = "computer-launcher.pid";
const DAEMON_PID_FILE = "daemon.pid";
const DAEMON_PACKAGE_NAME = "@collabagent/daemon";

/* ------------------------------ 路径 / 进程基元 ------------------------------ */

/**
 * daemon 根目录判定（单目录版，用于 SLOCK_DAEMON_ROOT env 校验）：
 * repo 形态 = 含名字为 @collabagent/daemon 的 package.json；
 * 发行/安装形态没有 package.json——以含 daemon.cjs（平铺或
 * dist-bundle/ 子目录）为标记。向上遍历的两趟优先级见 findDaemonRootUp。
 */
function isDaemonRoot(dir: string): boolean {
  return hasDaemonPackageJson(dir) || hasDaemonBundle(dir);
}

/**
 * 向上找 daemon 根（cli.ts 在 src/cli 下两级；cli.cjs 与 daemon.cjs 同目录）。
 * 两趟扫描：第一趟只认 named package.json（repo 包根是规范根）；
 * 第二趟才认 daemon.cjs bundle 布局——否则 argv[1] 落在 dist-bundle/
 * 时会把产物目录当根，stateDir 裂成 dist-bundle/.slock 与 repo .slock
 * 两棵树（同一 server 双 daemon.pid，单实例守卫失效）。
 */
function findDaemonRootUp(startDir: string): string | null {
  const start = resolve(startDir);
  for (const pass of [0, 1] as const) {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      if (pass === 0 ? hasDaemonPackageJson(dir) : hasDaemonBundle(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

function hasDaemonPackageJson(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return pkg?.name === DAEMON_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function hasDaemonBundle(dir: string): boolean {
  return existsSync(join(dir, "daemon.cjs")) || existsSync(join(dir, "dist-bundle", "daemon.cjs"));
}

/** npm i -g 本地目录装 = symlink/junction——根路径穿链接归一，否则 stateDir 裂两棵树 */
const normalizeRoot = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * daemon 包根解析：SLOCK_DAEMON_ROOT > import.meta.url（tsx 直跑）>
 * argv[1]（bundle 落在 <stateDir>/slock-cli.cjs 时，上级目录恰是包根的常见布局）>
 * setup 时存进 profile 的 daemonRoot。返回值一律 realpath 归一。
 */
export function resolveDaemonRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SLOCK_DAEMON_ROOT?.trim();
  if (override && isDaemonRoot(override)) return normalizeRoot(resolve(override));
  const seeds: string[] = [];
  try {
    if (import.meta.url) seeds.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* esbuild cjs bundle 下 import.meta 为空对象 */
  }
  if (process.argv[1]) seeds.push(dirname(resolve(process.argv[1])));
  for (const seed of seeds) {
    const root = findDaemonRootUp(seed);
    if (root) return normalizeRoot(root);
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
  const root =
    deps?.daemonRoot ?? resolveDaemonRoot() ?? (profile.daemonRoot ? normalizeRoot(profile.daemonRoot) : null);
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
 * daemon 入口探测：src/supervisor.ts（dev，watch+崩溃重启）> 发行包
 * daemon.cjs > dist/index.js（tsc 构建）。repo 里即便 build:dist 过也优先
 * supervisor，保持开发态热重载语义。
 */
function resolveLaunchEntry(root: string): { cmd: string; mode: string } {
  const supervisorEntry = join(root, "src", "supervisor.ts");
  const bundleEntry = findDistAsset("daemon.cjs", { envVar: "SLOCK_DAEMON_BUNDLE", root });
  const distEntry = join(root, "dist", "index.js");
  if (existsSync(supervisorEntry)) {
    return { cmd: `npx tsx "${supervisorEntry}"`, mode: "supervisor+tsx" };
  }
  if (bundleEntry) {
    return { cmd: `"${process.execPath}" "${bundleEntry}"`, mode: "bundle daemon.cjs" };
  }
  if (existsSync(distEntry)) {
    return { cmd: `"${process.execPath}" "${distEntry}"`, mode: "dist" };
  }
  fail(
    "daemon-entry-missing",
    `no daemon entry found under ${root} (looked for src/supervisor.ts, daemon.cjs, dist/index.js) — run pnpm build:dist or setup again`,
  );
}

/** profile → env 翻译（唯一翻译点，start/_run 共用） */
function buildLaunchEnv(profile: ComputerProfile, name: string, root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SLOCK_SERVER_URL: profile.serverUrl,
    SLOCK_API_KEY: profile.apiKey,
    SLOCK_SERVER_NAME: name,
    SLOCK_DAEMON_ROOT: root,
    ...(profile.machineUuid ? { SLOCK_MACHINE_ID: profile.machineUuid } : {}),
    ...(profile.stateDir ? { SLOCK_STATE_DIR: profile.stateDir } : {}),
  };
}

/**
 * _run 拉起循环的自重入 argv：cli.cjs（发行布局）> tsx cli.mjs + src/cli.ts（dev）。
 * 返回 argv 而非 cmd 串——Windows 下 detached+shell 会把 stdio fd 重定向丢光
 * （实测：cmd /d /s /c 包装层不继承自定义 stdio 句柄），必须直起 node。
 */
function resolveSelfArgv(root: string): { bin: string; args: string[] } | null {
  const cliBundle = findDistAsset("cli.cjs", { envVar: "SLOCK_CLI_BUNDLE", root });
  if (cliBundle) return { bin: process.execPath, args: [cliBundle] };
  const cliSrc = join(root, "src", "cli.ts");
  if (existsSync(cliSrc)) {
    const tsx = resolveTsxCli(root);
    if (tsx) return { bin: process.execPath, args: [tsx, cliSrc] };
  }
  return null;
}

/** dev 布局的 tsx 入口：<root>/node_modules/tsx/dist/cli.mjs 或 require.resolve 兜底 */
function resolveTsxCli(root: string): string | null {
  const direct = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(direct)) return direct;
  try {
    const req = createRequire(join(root, "package.json"));
    const pkg = req.resolve("tsx/package.json");
    const cli = join(dirname(pkg), "dist", "cli.mjs");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

export interface StartOptions {
  /** true = 后台：detach + stdio→daemon.log + unref，经 _run 拉起循环托管 */
  detach?: boolean;
}

/**
 * 启动：默认前台 spawn 入口（保留 supervisor watch + 崩溃重启）并把
 * launcher pid 落盘；--detach 改经 `computer _run` 拉起循环后台托管
 * （日志落 <stateDir>/daemon.log）。restart 语义由调用方先 computerStop
 * 再进本函数保证——单实例守卫只能挡 daemon 层，挡不住 launcher 层的
 * 「谁后写谁赢」。
 */
export async function computerStart(argName: string | undefined, opts?: StartOptions, deps?: ComputerDeps) {
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

  if (opts?.detach) {
    const self = resolveSelfArgv(root);
    if (!self) {
      fail("cli-entry-missing", `cannot locate slock CLI entry under ${root} — run pnpm build:dist or setup again`);
    }
    mkdirPrivateSync(stateDir);
    const logPath = join(stateDir, "daemon.log");
    const fd = openSync(logPath, "a");
    const child = spawn(self.bin, [...self.args, "computer", "_run", `/${name}`], {
      cwd: root,
      env: process.env, // _run 自重解 profile → env（registry 在 ~/.slock，机器级）
      stdio: ["ignore", fd, fd],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
    if (child.pid) writeFileSync(launcherPidPath, String(child.pid));
    const mode = `${resolveLaunchEntry(root).mode} detached`;
    return {
      ok: true,
      data: {
        name,
        attached: false,
        detached: true,
        launcherPid: child.pid ?? null,
        mode,
        stateDir,
        log: logPath,
        hint: "slock computer status / logs / stop",
      },
    };
  }

  const plan = resolveLaunchEntry(root);
  const env = buildLaunchEnv(profile, name, root);
  const cmd = plan.cmd;
  const mode = plan.mode;

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

/* ------------------------------ _run 拉起循环（内部） ------------------------------ */

const RUN_BACKOFF_MS = 1_000;
const RUN_CRASH_WINDOW_MS = 60_000;
const RUN_CRASH_LIMIT = 5;
const RUN_CRASH_BACKOFF_MS = 30_000;

/**
 * `slock computer _run` —— `start --detach` 的后台拉起循环（内部命令）。
 * 语义与 supervisor.ts 崩溃重启对齐：正常退出 1s 后拉起；1 分钟内 >5 次
 * 崩溃退避 30s。bundle 布局没有 supervisor，这层循环是 daemon 唯一的
 * 看门人；有 supervisor 的布局它只是多一道兜底（supervisor 全退才接管）。
 * 信号 = 整树关停；stdio inherit——detached 时指向 daemon.log fd。
 */
export async function computerRun(argName: string, deps?: ComputerDeps) {
  const profiles = loadComputerProfiles(deps?.registryPath);
  const { name, profile } = resolveComputerTarget(argName, profiles);
  const root = rootFor(profile, deps);
  const stateDir = resolveStateDir(profile, root);
  const plan = resolveLaunchEntry(root);
  const env = buildLaunchEnv(profile, name, root);
  mkdirPrivateSync(stateDir);

  let stopping = false;
  let child: ChildProcess | null = null;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    if (child?.pid) killPidTree(child.pid);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const crashes: number[] = [];
  let lastCode = 0;
  while (!stopping) {
    child = spawn(plan.cmd, { cwd: root, env, stdio: "inherit", shell: true, windowsHide: true });
    const spawnErr: { err: Error | null } = { err: null };
    child.once("error", (e) => {
      spawnErr.err = e;
    });
    const code = await new Promise<number>((res) => {
      child!.once("exit", (c) => res(c ?? 0));
      child!.once("error", () => res(1));
    });
    lastCode = code;
    child = null;
    if (stopping) break;
    crashes.push(Date.now());
    const recent = crashes.filter((t) => Date.now() - t < RUN_CRASH_WINDOW_MS);
    const delay = recent.length > RUN_CRASH_LIMIT ? RUN_CRASH_BACKOFF_MS : RUN_BACKOFF_MS;
    console.log(
      `[computer-run] ${name} exited (code ${code}${spawnErr.err ? `, spawn error: ${spawnErr.err.message}` : ""}); respawn in ${delay}ms`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return { ok: true, data: { name, stopped: true, lastCode } };
}

/* ------------------------------ status / logs ------------------------------ */

/** status/stop 共用的 root+stateDir 解析（root 缺失不 fail——只报 stateDir 未知） */
function rootAndStateDir(profile: ComputerProfile, deps?: ComputerDeps) {
  const root =
    deps?.daemonRoot ?? resolveDaemonRoot() ?? (profile.daemonRoot ? normalizeRoot(profile.daemonRoot) : null);
  return { root, stateDir: root ? resolveStateDir(profile, root) : null };
}

const pidStat = (stateDir: string | null, file: string) => {
  const pid = stateDir ? readPidFile(join(stateDir, file)) : null;
  return { pid, alive: pid !== null && pidAlive(pid) };
};

export function computerStatus(argName: string | undefined, deps?: ComputerDeps) {
  const profiles = loadComputerProfiles(deps?.registryPath);
  const { name, profile } = resolveComputerTarget(argName, profiles);
  const { stateDir } = rootAndStateDir(profile, deps);
  const launcher = pidStat(stateDir, LAUNCHER_PID_FILE);
  const daemon = pidStat(stateDir, DAEMON_PID_FILE);
  const log = stateDir ? join(stateDir, "daemon.log") : null;
  return {
    ok: true,
    data: {
      name,
      running: launcher.alive || daemon.alive,
      launcher,
      daemon,
      stateDir,
      log: log && existsSync(log) ? log : null,
      autostart: autostartInstalled(name),
    },
  };
}

export function computerLogs(argName: string | undefined, opts?: { lines?: number }, deps?: ComputerDeps) {
  const profiles = loadComputerProfiles(deps?.registryPath);
  const { name, profile } = resolveComputerTarget(argName, profiles);
  const { stateDir } = rootAndStateDir(profile, deps);
  if (!stateDir)
    fail("state-dir-unknown", "cannot locate state dir — re-run `slock computer setup` or set SLOCK_DAEMON_ROOT");
  const logPath = join(stateDir, "daemon.log");
  if (!existsSync(logPath)) {
    fail("no-log", `no daemon log at ${logPath} — start with --detach to produce one`);
  }
  const raw = readFileSync(logPath, "utf-8");
  const n = Math.max(1, Math.min(opts?.lines ?? 50, 5000));
  const all = raw.split(/\r?\n/);
  // 文件末尾恒带换行 → 最后一个元素是空串，剔除
  const tail = all.slice(-(n + 1)).filter((l, i, a) => !(i === a.length - 1 && l === ""));
  return { ok: true, data: { name, path: logPath, total: all.length, tail } };
}

/* ------------------------------ install / uninstall（登录自启） ------------------------------ */

/** 自启注册的 cli 入口：必须是 node 直跑的 .cjs（登录态没有 pnpm/tsx 上下文） */
function cliCjsForAutostart(root: string): string | null {
  const bundled = findDistAsset("cli.cjs", { envVar: "SLOCK_CLI_BUNDLE", root });
  if (bundled) return bundled;
  const argv1 = process.argv[1];
  if (argv1 && argv1.endsWith(".cjs") && existsSync(argv1)) return resolve(argv1);
  return null;
}

export function computerInstall(argName: string | undefined, deps?: ComputerDeps) {
  const profiles = loadComputerProfiles(deps?.registryPath);
  const { name, profile } = resolveComputerTarget(argName, profiles);
  const root = rootFor(profile, deps);
  const cliPath = cliCjsForAutostart(root);
  if (!cliPath) {
    fail(
      "cli-bundle-required",
      "autostart needs a node-runnable cli.cjs — run `pnpm build:dist` (repo) or install the release bundle",
    );
  }
  return installAutostart(name, process.execPath, cliPath);
}

export function computerUninstall(argName: string | undefined, deps?: ComputerDeps) {
  const profiles = loadComputerProfiles(deps?.registryPath);
  const { name } = resolveComputerTarget(argName, profiles);
  return removeAutostart(name);
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
    .description("Start the daemon for an enrolled server (/ <name> or bare name)")
    .option("--detach", "run in background (log -> <stateDir>/daemon.log, crash-respawn via _run)")
    .action(async (name: string | undefined, o: { detach?: boolean }) => {
      const r = await computerStart(name, { detach: o.detach });
      if (!r.data.attached) emit(r); // 前台路径 spawn 时已 emit；早退/失败/detach 在此补输出
      if (!r.ok) process.exitCode = 1;
    });

  parent
    .command("restart [name]")
    .description("Restart the daemon (not running = plain start)")
    .option("--detach", "run in background (same as start --detach)")
    .action(async (name: string | undefined, o: { detach?: boolean }) => {
      computerStop(name); // 幂等：没在跑也 ok
      const r = await computerStart(name, { detach: o.detach });
      if (!r.data.attached) emit(r);
      if (!r.ok) process.exitCode = 1;
    });

  parent
    .command("stop [name]")
    .description("Stop the daemon (kill launcher + daemon process tree)")
    .action((name?: string) => emit(computerStop(name)));

  parent
    .command("status [name]")
    .description("Show launcher/daemon pid liveness and autostart registration")
    .action((name?: string) => emit(computerStatus(name)));

  parent
    .command("logs [name]")
    .description("Tail <stateDir>/daemon.log (default 50 lines)")
    .option("-n, --lines <n>", "number of lines", "50")
    .action((name: string | undefined, o: { lines?: string }) => {
      const r = computerLogs(name, { lines: Number(o.lines) });
      // 人读命令：直接打文本而非 JSON 包裹
      process.stdout.write(`# ${r.data.path} (last ${r.data.tail.length}/${r.data.total} lines)\n`);
      for (const line of r.data.tail) process.stdout.write(line + "\n");
    });

  parent
    .command("install [name]")
    .description("Register login autostart (schtasks / launchd / systemd --user)")
    .action((name?: string) => emit(computerInstall(name)));

  parent
    .command("uninstall [name]")
    .description("Remove login autostart registration")
    .action((name?: string) => emit(computerUninstall(name)));

  parent
    .command("_run <name>", { hidden: true })
    .description("(internal) detached launcher loop spawned by start --detach")
    .action(async (name: string) => {
      const r = await computerRun(name);
      if (!r.ok) process.exitCode = 1;
    });
}
