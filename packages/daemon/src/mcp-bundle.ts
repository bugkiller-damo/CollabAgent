import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 打包 MCP server（见 src/mcp/slock-mcp-server.ts）到共享位置
 * `.slock/slock-mcp-server.cjs`。
 *
 * 跟 setup-slock-wrapper.ts 打包 `slock` CLI 的思路一致：所有 agent 共用同一份
 * 打包产物，每个 agent workspace 只需要写一份指向它、env 不同的 `.mcp.json`
 * （见 agent-runtime-spawn.ts）。用模块级缓存的 Promise 做 memoize——daemon
 * 整个生命周期只打包一次，第一次 spawn 付编译成本，之后全部立即 resolve。
 *
 * 打包失败时返回 null（网络受限环境、esbuild 缺失等）；调用方应该跳过写
 * `.mcp.json`，而不是让整个 spawn 失败——MCP 只是 CLI 之外一条更结构化的
 * 通道，不是启动的硬依赖，agent 仍可以退回用 `slock` CLI。
 */
let cached: Promise<string | null> | null = null;

export function bundleSlockMcpServer(): Promise<string | null> {
  if (!cached) {
    cached = (async () => {
      try {
        // mcp/slock-mcp-server.ts 与本文件同目录下的 mcp/ 子目录；按源码位置
        // 解析，避免依赖 cwd（跟 setup-slock-wrapper.ts 解析 cli.ts 的方式一致）。
        const srcDir = dirname(fileURLToPath(import.meta.url));
        const entryPath = join(srcDir, "mcp", "slock-mcp-server.ts");
        const slockDir = join(process.cwd(), ".slock");
        mkdirSync(slockDir, { recursive: true });
        const bundlePath = join(slockDir, "slock-mcp-server.cjs");

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
