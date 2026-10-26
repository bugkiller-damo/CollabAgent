import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findDistAsset } from "./dist-assets.js";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";

/**
 * 生成 slock wrapper（slock.bat + CLI 预打包）。
 * agent 进程中 `slock` 命令即指向此 wrapper，确保环境变量正确。
 *
 * O11：脚本不再内嵌任何 token——旧版把「账号级 apiKey」明文写进
 * .slock/slock.bat / .slock/slock（磁盘长期驻留，正是 scoped-token 机制想关掉的洞）。
 * agent PTY 内 token 经 SLOCK_AGENT_TOKEN_FILE 传递（随 PTY env 继承，wrapper 无需
 * 代设）；PTY 外手工调 slock 没有凭证时，CLI 会报明确的 MISSING_TOKEN 错误。
 *
 * CLI 产物来源（S1，2026-10-23）：
 *   1. 发行包预打 `cli.cjs`（findDistAsset：SLOCK_CLI_BUNDLE > install/包根
 *      探测）——复制到 `.slock/slock-cli.cjs`，agent 侧 `node <path>` 直跑；
 *   2. dev 形态运行时 esbuild `src/cli.ts`（import.meta 在 bundle 下为空，
 *      须判空；esbuild 为 devDep，发行包里 import 会失败——两级兜底）；
 *   3. 都没有 → wrapper 直接调 PATH 上的 `slock`（全局安装形态 shim 已就位）。
 */
export async function setupSlockWrapper(agentId: string, serverUrl: string): Promise<string> {
  const stateDir = slockDir();
  mkdirPrivateSync(stateDir);
  const bundlePath = join(stateDir, "slock-cli.cjs");

  let runCmd: string | null = null;
  let shRunCmd = "";

  // src/cli.ts 与本文件同目录（src/）；bundle 下 import.meta.url 为空，判空
  let cliPath: string | null = null;
  try {
    if (import.meta.url) cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
  } catch {
    /* cjs bundle：无源码位置可言 */
  }

  const prebuilt = findDistAsset("cli.cjs", { envVar: "SLOCK_CLI_BUNDLE" });
  if (prebuilt) {
    if (resolve(prebuilt) !== resolve(bundlePath)) copyFileSync(prebuilt, bundlePath);
    runCmd = `node "${bundlePath}" %*`;
    shRunCmd = `node "${bundlePath.replace(/\\/g, "/")}" "$@"`;
    console.log(`[Daemon] CLI bundle copied -> ${bundlePath} (from ${prebuilt})`);
  } else if (cliPath && existsSync(cliPath)) {
    const cliPathPosix = cliPath.replace(/\\/g, "/");
    runCmd = `npx tsx "${cliPath}" %*`;
    shRunCmd = `npx tsx "${cliPathPosix}" "$@"`;
    try {
      const esbuild = await import("esbuild");
      await esbuild.build({
        entryPoints: [cliPath],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node18",
        outfile: bundlePath,
        logLevel: "silent",
      });
      runCmd = `node "${bundlePath}" %*`;
      shRunCmd = `node "${bundlePath.replace(/\\/g, "/")}" "$@"`;
      console.log(`[Daemon] CLI bundled -> ${bundlePath} (slock runs via node)`);
    } catch (err: any) {
      console.warn(`[Daemon] CLI bundle failed, falling back to npx tsx: ${err?.message}`);
    }
  }
  if (!runCmd) {
    // 发行形态兜底：全局 slock shim（install 脚本装进 PATH）；dev 异常路径
    // （cli.ts 缺失）也落到这里——agent 会拿到明确的 command-not-found。
    runCmd = `slock %*`;
    shRunCmd = `slock "$@"`;
    console.warn("[Daemon] no CLI source/bundle found — slock wrapper defers to PATH");
  }

  const batContent = [
    `@echo off`,
    `if not defined SLOCK_AGENT_ID set SLOCK_AGENT_ID=${agentId}`,
    `if not defined SLOCK_SERVER_URL set SLOCK_SERVER_URL=${serverUrl}`,
    `if not defined SLOCK_AGENT_ACTIVE_CAPABILITIES set SLOCK_AGENT_ACTIVE_CAPABILITIES=send,read,mentions,tasks,reactions,server,channels`,
    runCmd,
  ].join("\r\n");
  writeFileSync(join(stateDir, "slock.bat"), batContent);

  // 无扩展名的 sh wrapper：Claude Code 的 Bash 工具在 Windows 上走 git-bash，
  // bash 不解析 PATHEXT，敲 `slock` 找不到 `slock.bat`（2026-07-17 实测 agent
  // 报告 "slock CLI 不在 bash PATH 中"，自己摸到全路径才调通）。同名无扩展名
  // 的 POSIX 脚本让 bash 也能直接命中。
  const shContent = [
    `#!/bin/sh`,
    `: "\${SLOCK_AGENT_ID:=${agentId}}"`,
    `: "\${SLOCK_SERVER_URL:=${serverUrl}}"`,
    `: "\${SLOCK_AGENT_ACTIVE_CAPABILITIES:=send,read,mentions,tasks,reactions,server,channels}"`,
    `export SLOCK_AGENT_ID SLOCK_SERVER_URL SLOCK_AGENT_ACTIVE_CAPABILITIES`,
    shRunCmd,
    ``,
  ].join("\n");
  writeFileSync(join(stateDir, "slock"), shContent);
  console.log(`[Daemon] slock wrapper written to ${stateDir}/slock.bat + ${stateDir}/slock (sh)`);

  const currentPath = process.env.PATH || "";
  if (!currentPath.includes(stateDir)) {
    process.env.PATH = `${stateDir};${currentPath}`;
  }

  return stateDir;
}
