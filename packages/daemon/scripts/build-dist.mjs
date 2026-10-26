#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * S1 产物化：esbuild 单文件打包 → dist-bundle/
 *
 *   daemon.cjs            <- src/index.ts          （bin: collabagent-daemon）
 *   cli.cjs               <- src/cli.ts            （bin: slock）
 *   slock-mcp-server.cjs  <- src/mcp/slock-mcp-server.ts（agent MCP server，
 *                          由 mcp-bundle.ts 的 findDistAsset 预打路径消费）
 *
 * external：
 *   - node-pty          原生依赖，发行包不带；headless 默认路径根本不加载它
 *                       （agent-manager-lazy 惰性 import，缺失时给可读错误）
 *   - esbuild           devDep；setup-slock-wrapper/mcp-bundle 的运行时打包
 *                       是 dev 回落路径，bundle 里 import 失败走预打产物/降级
 *   - bufferutil / utf-8-validate  ws 的可选原生加速，缺失即纯 JS 实现
 */
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-bundle");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
  legalComments: "none",
  external: ["node-pty", "esbuild", "bufferutil", "utf-8-validate"],
};

// index.ts / cli.ts 源文件自带 #!/usr/bin/env node 首行，esbuild 原样保留，
// 无需再加 banner（加了会变成双 shebang——第二条落在非 0 偏移即语法错误）。
const entries = [
  { in: "src/index.ts", out: "daemon.cjs" },
  { in: "src/cli.ts", out: "cli.cjs" },
  { in: "src/mcp/slock-mcp-server.ts", out: "slock-mcp-server.cjs" },
];

for (const e of entries) {
  await build({
    ...common,
    entryPoints: [join(root, e.in)],
    outfile: join(outDir, e.out),
  });
}
console.log(`dist-bundle ready -> ${outDir} (daemon.cjs / cli.cjs / slock-mcp-server.cjs)`);
