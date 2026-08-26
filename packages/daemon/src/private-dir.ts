import { chmodSync, mkdirSync } from "node:fs";

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
