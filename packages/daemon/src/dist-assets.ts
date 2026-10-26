/**
 * 发行产物定位（S1 产物化，2026-10-23）。
 *
 * bundle/安装形态下没有 src/ 可供运行时 esbuild——setup-slock-wrapper 与
 * mcp-bundle 需要一份「构建期预打好的 cjs」。探测顺序：
 *
 *   1. 显式 env 覆盖（envVar 指定，如 SLOCK_CLI_BUNDLE / SLOCK_MCP_BUNDLE /
 *      SLOCK_DAEMON_BUNDLE）
 *   2. <root>/<file> 与 <root>/dist-bundle/<file>——root 候选依次取
 *      opts.root > SLOCK_DAEMON_ROOT > argv[1] 目录（cli.cjs/daemon.cjs
 *      彼此同目录的常见发行布局）> import.meta 目录向上找包根
 *
 * 找不到返回 null——由调用方回退既有路径（esbuild src / tsx / 报错），
 * 开发态行为完全不变。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_PACKAGE_NAME = "@collabagent/daemon";

function packageRootUp(startDir: string): string | null {
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

function importMetaDir(): string | null {
  try {
    // esbuild cjs bundle 下 import.meta 为空对象，url 为 undefined
    return import.meta.url ? dirname(fileURLToPath(import.meta.url)) : null;
  } catch {
    return null;
  }
}

export interface FindDistAssetOptions {
  /** 覆盖 env 变量名（如 "SLOCK_CLI_BUNDLE"），指向文件路径 */
  envVar?: string;
  /** 已解析的 daemon/install 根目录，优先于自解析 */
  root?: string;
  /** 完整替换根候选（测试隔离用）；给定后不再做 argv[1]/import.meta 自解析 */
  roots?: string[];
  /** 测试注入 env；缺省 process.env */
  env?: NodeJS.ProcessEnv;
}

export function findDistAsset(fileName: string, opts?: FindDistAssetOptions): string | null {
  const env = opts?.env ?? process.env;
  const override = opts?.envVar ? env[opts.envVar]?.trim() : "";
  if (override && existsSync(override)) return resolve(override);

  const roots: string[] = opts?.roots ? [...opts.roots] : [];
  if (!opts?.roots) {
    if (opts?.root) roots.push(opts.root);
    if (env.SLOCK_DAEMON_ROOT?.trim()) roots.push(env.SLOCK_DAEMON_ROOT.trim());
    if (process.argv[1]) roots.push(dirname(resolve(process.argv[1])));
    const meta = importMetaDir();
    if (meta) {
      roots.push(meta);
      const pkgRoot = packageRootUp(meta);
      if (pkgRoot) roots.push(pkgRoot);
    }
  }

  const seen = new Set<string>();
  for (const root of roots) {
    for (const candidate of [join(root, fileName), join(root, "dist-bundle", fileName)]) {
      const p = resolve(candidate);
      if (seen.has(p)) continue;
      seen.add(p);
      if (existsSync(p)) return p;
    }
  }
  return null;
}
