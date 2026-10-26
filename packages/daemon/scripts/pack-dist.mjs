#!/usr/bin/env node
/**
 * pack-dist.mjs —— 打发行包（S3-B/S4 通道输入）。
 *
 * 产出 release/ 目录（可整目录挂到 server /dl/ 或传 GitHub Releases）：
 *   slock-daemon-<ver>.tar.gz        三个 cjs 平铺包根（cli/daemon/slock-mcp-server）
 *   slock-daemon-<ver>.tar.gz.sha256 "<hash>  <name>"
 *   version.json                   {"version":"<ver>","artifact":"<name>","sha256":"<hash>"}
 *   install.ps1 / install.sh       从 ../install/ 复制（单源维护）
 *
 * 用法：node scripts/pack-dist.mjs [--skip-build]
 * （默认先跑 build-dist.mjs 保证产物新鲜）
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
const bundleDir = join(root, "dist-bundle");
const outDir = join(root, "release");
const name = `slock-daemon-${version}.tar.gz`;

if (!process.argv.includes("--skip-build")) {
  execFileSync(process.execPath, [join(root, "scripts", "build-dist.mjs")], { stdio: "inherit" });
}

mkdirSync(outDir, { recursive: true });
// tar 打平三个 cjs 到包根（安装布局 = <runtime>/<ver>/daemon.cjs 直认根）
const files = ["daemon.cjs", "cli.cjs", "slock-mcp-server.cjs"];
execFileSync("tar", ["-czf", join(outDir, name), "-C", bundleDir, ...files], { stdio: "inherit" });

const sha256 = createHash("sha256")
  .update(readFileSync(join(outDir, name)))
  .digest("hex");
writeFileSync(join(outDir, `${name}.sha256`), `${sha256}  ${name}\n`);
writeFileSync(join(outDir, "version.json"), `${JSON.stringify({ version, artifact: name, sha256 }, null, 2)}\n`);
for (const s of ["install.ps1", "install.sh"]) {
  cpSync(join(root, "install", s), join(outDir, s));
}

console.log(`\nrelease ready -> ${outDir}`);
console.log(`  ${name} (sha256 ${sha256.slice(0, 12)}…)`);
console.log(`  serve: DAEMON_INSTALL_CMD="irm https://<host>/dl/install.ps1 | iex"`);
