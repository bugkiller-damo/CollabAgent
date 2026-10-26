import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findDistAsset } from "./dist-assets.js";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";

/**
 * 打包 MCP server（见 src/mcp/slock-mcp-server.ts）到共享位置
 * `.slock/slock-mcp-server.cjs`。
 *
 * 跟 setup-slock-wrapper.ts 打包 `slock` CLI 的思路一致：所有 agent 共用同一份
 * 打包产物，每个 agent workspace 只需要写一份指向它、env 不同的 `.mcp.json`
 * （见 agent-runtime-spawn.ts）。用模块级缓存的 Promise 做 memoize——daemon
 * 整个生命周期只打包一次，第一次 spawn 付编译成本，之后全部立即 resolve。
 *
 * 产物来源（S1，2026-10-23）：
 *   1. 发行包预打 `slock-mcp-server.cjs`（findDistAsset：SLOCK_MCP_BUNDLE >
 *      install/包根探测）——复制进 stateDir；
 *   2. dev 形态运行时 esbuild `mcp/slock-mcp-server.ts`（bundle 下
 *      import.meta 为空且 esbuild 是 devDep——两级兜底）；
 *   3. 打包失败时返回 null（网络受限环境、esbuild 缺失等）；调用方应该跳过写
 * `.mcp.json`，而不是让整个 spawn 失败——MCP 只是 CLI 之外一条更结构化的
 * 通道，不是启动的硬依赖，agent 仍可以退回用 `slock` CLI。
 */
let cached: Promise<string | null> | null = null;

export function bundleSlockMcpServer(): Promise<string | null> {
  if (!cached) {
    cached = (async () => {
      try {
        const stateDir = slockDir();
        mkdirPrivateSync(stateDir);
        const bundlePath = join(stateDir, "slock-mcp-server.cjs");

        const prebuilt = findDistAsset("slock-mcp-server.cjs", { envVar: "SLOCK_MCP_BUNDLE" });
        if (prebuilt) {
          if (resolve(prebuilt) !== resolve(bundlePath)) copyFileSync(prebuilt, bundlePath);
          console.log(`[Runtime] MCP server bundle copied -> ${bundlePath} (from ${prebuilt})`);
          return bundlePath;
        }

        // mcp/slock-mcp-server.ts 与本文件同目录下的 mcp/ 子目录；按源码位置
        // 解析，避免依赖 cwd（跟 setup-slock-wrapper.ts 解析 cli.ts 的方式一致）。
        let srcDir: string | null = null;
        try {
          if (import.meta.url) srcDir = dirname(fileURLToPath(import.meta.url));
        } catch {
          /* cjs bundle：无源码位置可言 */
        }
        const entryPath = srcDir ? join(srcDir, "mcp", "slock-mcp-server.ts") : null;
        if (!entryPath || !existsSync(entryPath)) return null;

        const esbuild = await import("esbuild");
        await esbuild.build({
          entryPoints: [entryPath],
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node18",
          outfile: bundlePath,
          logLevel: "silent",
        });
        console.log(`[Runtime] MCP server bundled -> ${bundlePath}`);
        return bundlePath;
      } catch (err: any) {
        console.warn(
          `[Runtime] MCP server bundle failed, agents will fall back to slock CLI only: ${err?.message ?? err}`,
        );
        return null;
      }
    })();
  }
  return cached;
}
