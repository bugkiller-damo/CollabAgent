/**
 * 进程入口级 .env 加载（与 server `lib/config.ts` 的 dotenv 同构）。
 *
 * 候选位置（首个存在的生效）：
 *   1. `SLOCK_DAEMON_ROOT/.env`（发行/安装布局显式指定）
 *   2. `<import.meta 目录>/../.env`（dev：src/ 上一级 = 包根）
 *   3. `<argv[1] 目录>/.env`（发行布局：.env 与 daemon.cjs 同目录）
 * 不依赖进程 cwd——从仓库根 `pnpm --filter @collabagent/daemon dev` 与
 * 包内 `pnpm dev` 命中同一份。dotenv 默认不覆盖已注入的环境变量
 * （显式 env 优先，测试/CI 安全）。
 *
 * esbuild cjs bundle 下 import.meta.url 为 undefined——判空后才能调
 * fileURLToPath，否则入口 import 即炸（S1 产物化修复）。
 *
 * 纪律：**只被进程入口 import（index.ts / supervisor.ts），且必须是第一行
 * import**——ESM 按 import 顺序执行模块顶层代码，前置 import 保证在任何
 * 模块读 process.env 之前 .env 已就位。config.ts 不加载它：loadDaemonEnv
 * 是纯函数且被测试 import，顶层副作用会污染测试 env。
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const candidates: string[] = [];
if (process.env.SLOCK_DAEMON_ROOT?.trim()) {
  candidates.push(resolve(process.env.SLOCK_DAEMON_ROOT.trim(), ".env"));
}
try {
  if (import.meta.url) {
    candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"));
  }
} catch {
  /* cjs bundle：import.meta.url 不可用 */
}
if (process.argv[1]) {
  candidates.push(resolve(dirname(process.argv[1]), ".env"));
}
const envFile = candidates.find((p) => existsSync(p));
if (envFile) {
  dotenv.config({ path: envFile, quiet: true });
}
