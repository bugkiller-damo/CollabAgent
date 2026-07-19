import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 生成 slock wrapper（slock.bat + CLI 预打包）。
 * agent 进程中 `slock` 命令即指向此 wrapper，确保环境变量正确。
 */
export async function setupSlockWrapper(agentId: string, serverUrl: string, apiKey: string): Promise<string> {
  const slockDir = join(process.cwd(), ".slock");
  mkdirSync(slockDir, { recursive: true });

  // cli.ts 与本文件同目录（src/）；按源码位置解析，避免依赖 cwd
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(srcDir, "cli.ts");

  let runCmd = `npx tsx "${cliPath}" %*`;
  let shRunCmd = "";
  const cliPathPosix = cliPath.replace(/\\/g, "/");
  try {
    const esbuild = await import("esbuild");
    const bundlePath = join(slockDir, "slock-cli.cjs");
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
    shRunCmd = `npx tsx "${cliPathPosix}" "$@"`;
  }

  const batContent = [
    `@echo off`,
    `if not defined SLOCK_AGENT_ID set SLOCK_AGENT_ID=${agentId}`,
    `if not defined SLOCK_SERVER_URL set SLOCK_SERVER_URL=${serverUrl}`,
    `if not defined SLOCK_AGENT_TOKEN set SLOCK_AGENT_TOKEN=${apiKey}`,
    `if not defined SLOCK_AGENT_ACTIVE_CAPABILITIES set SLOCK_AGENT_ACTIVE_CAPABILITIES=send,read,mentions,tasks,reactions,server,channels`,
    runCmd,
  ].join("\r\n");
  writeFileSync(join(slockDir, "slock.bat"), batContent);

  // 无扩展名的 sh wrapper：Claude Code 的 Bash 工具在 Windows 上走 git-bash，
  // bash 不解析 PATHEXT，敲 `slock` 找不到 `slock.bat`（2026-07-17 实测 agent
  // 报告 "slock CLI 不在 bash PATH 中"，自己摸到全路径才调通）。同名无扩展名
  // 的 POSIX 脚本让 bash 也能直接命中。
  const shContent = [
    `#!/bin/sh`,
    `: "\${SLOCK_AGENT_ID:=${agentId}}"`,
    `: "\${SLOCK_SERVER_URL:=${serverUrl}}"`,
    `: "\${SLOCK_AGENT_TOKEN:=${apiKey}}"`,
    `: "\${SLOCK_AGENT_ACTIVE_CAPABILITIES:=send,read,mentions,tasks,reactions,server,channels}"`,
    `export SLOCK_AGENT_ID SLOCK_SERVER_URL SLOCK_AGENT_TOKEN SLOCK_AGENT_ACTIVE_CAPABILITIES`,
    shRunCmd,
    ``,
  ].join("\n");
  writeFileSync(join(slockDir, "slock"), shContent);
  console.log(`[Daemon] slock wrapper written to ${slockDir}/slock.bat + ${slockDir}/slock (sh)`);

  const currentPath = process.env.PATH || "";
  if (!currentPath.includes(slockDir)) {
    process.env.PATH = `${slockDir};${currentPath}`;
  }

  return slockDir;
}
