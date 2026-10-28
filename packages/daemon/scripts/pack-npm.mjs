#!/usr/bin/env node
/**
 * pack-npm.mjs —— npm 通道发行包（S4-D）。
 *
 * 为什么需要单独的 npm 打包：repo 的 package.json 有
 * `"@collabagent/shared": "workspace:*"`——pnpm 私有协议，npm 装不了。
 * 但 dist-bundle/*.cjs 是全量打包产物（shared 已内联），npm 包根本不需要
 * runtime 依赖。本脚本生成精简 package.json：
 *   - 删掉全部 dependencies（bundle 自包含）
 *   - 保留 optionalDependencies.node-pty（PTY 兜底路径可选装）
 *   - 加 engines.node>=20
 *
 * 产出：
 *   release/npm-pkg/                 npm 包目录（可直接 npm publish <dir>）
 *   release/collabagent-daemon-<ver>.tgz   npm pack 产物（可传 Releases / /dl/）
 *
 * 用法：
 *   pnpm pack:npm            # 打目录 + tgz
 *   npm publish release/npm-pkg --access public   # 发 registry（需 npm login + @collabagent scope）
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = srcPkg.version;
const outDir = join(root, "release");
const pkgDir = join(outDir, "npm-pkg");

if (!process.argv.includes("--skip-build")) {
  execFileSync(process.execPath, [join(root, "scripts", "build-dist.mjs")], { stdio: "inherit" });
}

rmSync(pkgDir, { recursive: true, force: true });
mkdirSync(join(pkgDir, "dist-bundle"), { recursive: true });
for (const f of ["daemon.cjs", "cli.cjs", "slock-mcp-server.cjs"]) {
  cpSync(join(root, "dist-bundle", f), join(pkgDir, "dist-bundle", f));
}
cpSync(join(root, "schemas"), join(pkgDir, "schemas"), { recursive: true });

const pubPkg = {
  name: srcPkg.name,
  version,
  description: "Slock computer daemon — outbound WS client connecting a machine to a Slock server",
  license: srcPkg.license ?? "UNLICENSED",
  type: "commonjs",
  bin: srcPkg.bin,
  engines: { node: ">=20" },
  optionalDependencies: srcPkg.optionalDependencies ?? {},
  ...(srcPkg.repository ? { repository: srcPkg.repository } : {}),
};
writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(pubPkg, null, 2)}\n`);

// npm CLI 入口：优先 node_modules/npm/bin/npm-cli.js（Node≥20 禁直 spawn .cmd，
// shell:true 又会引入路径引号地狱；npm-cli.js 全球 node 安装都自带）
const npmCliCandidates = [
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null,
].filter(Boolean);
const npmCli = npmCliCandidates.find((p) => existsSync(p));
if (!npmCli) throw new Error("npm-cli.js not found — install Node.js with bundled npm");
const tgz = execFileSync(process.execPath, [npmCli, "pack", "--pack-destination", outDir], {
  cwd: pkgDir,
  encoding: "utf-8",
}).trim();

console.log(`\nnpm package ready:`);
console.log(`  dir : ${pkgDir}`);
console.log(`  tgz : ${join(outDir, tgz)}`);
console.log(`\ninstall:  npm i -g ${join(outDir, tgz)}`);
console.log(`publish:  npm publish ${pkgDir} --access public   (needs npm login + @collabagent scope)`);
