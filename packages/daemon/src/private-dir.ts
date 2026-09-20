import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * H6：`.slock` 状态目录的唯一解析口。默认 `process.cwd()/.slock`；
 * `SLOCK_STATE_DIR` 可把整棵状态树（daemon.pid、成本/会话/运行 JSON、
 * workspaces、terminal-logs、planned-restart 标记等）搬到固定位置——
 * 此前全部散点 `process.cwd()`，从仓库根目录误启动 daemon 会把状态写丢到
 * 错误目录。调用时读 env，不冻成模块级常量（测试改 env 即生效）。
 */
export function slockDir(): string {
  const override = process.env.SLOCK_STATE_DIR?.trim();
  return override ? resolve(override) : join(process.cwd(), ".slock");
}

/**
 * P1.15：`.slock` 等保存敏感材料（scoped token、运行状态、终端日志）的目录
 * 统一收紧为 0700。Windows 上 chmod 语义有限（只反映到只读位），best-effort
 * 不抛错——POSIX 部署上这是真实边界；Windows 上目录本就在用户私有配置内。
 */
export function mkdirPrivateSync(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort：Windows / 不支持完整 chmod 语义的文件系统忽略
  }
}
