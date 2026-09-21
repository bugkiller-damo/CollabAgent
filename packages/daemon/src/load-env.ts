/**
 * 进程入口级 .env 加载（与 server `lib/config.ts` 的 dotenv 同构）。
 *
 * 定位 `<package root>/.env`（src/ 上一级），不依赖进程 cwd——从仓库根
 * `pnpm --filter @collabagent/daemon dev` 与包内 `pnpm dev` 命中同一份。
 * dotenv 默认不覆盖已注入的环境变量（显式 env 优先，测试/CI 安全）。
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

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, "../.env");
if (existsSync(envFile)) {
  dotenv.config({ path: envFile, quiet: true });
}
