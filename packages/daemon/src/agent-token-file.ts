import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivateSync } from "./private-dir.js";

/**
 * O11：agent scoped token 的落盘传递——替代「明文 token 进子进程 env / .mcp.json /
 * slock wrapper 脚本」的旧路径。
 *
 * 威胁模型：进程 env 对同机同用户是跨进程可读的（Linux /proc/<pid>/environ、
 * Windows 上 Process Explorer/WMI 均可枚举），还可能进 core dump / 崩溃上报。
 * 改成写文件后：token 只出现在 agent 自己 workspace 的 `.slock/agent-token`
 * （mode 0600；Windows 上 chmod 语义有限，但文件本就在用户私有目录内，
 * 相比「任何进程都能读 env」仍是严格收敛），子进程 env 里只有文件路径。
 *
 * 生命周期：每次 spawn 重新 mint + 覆盖写（同一路径，旧 token 文件不会滞留）；
 * run 退出时由 exit chain 调 removeAgentTokenFile 删除（best-effort——服务端
 * revoke + 24h TTL 已兜底，删不掉也只是死文件）。
 */

export const AGENT_TOKEN_FILENAME = "agent-token";

export function agentTokenFilePath(workspace: string): string {
  return join(workspace, ".slock", AGENT_TOKEN_FILENAME);
}

/** 写入 token 文件（0600），返回绝对路径。写失败应让本次 spawn 失败（fail-closed）。 */
export function writeAgentTokenFile(workspace: string, token: string): string {
  const p = agentTokenFilePath(workspace);
  // P1.15：.slock 目录本体也收紧 0700（此前只收紧了 token 文件 0600）
  mkdirPrivateSync(join(workspace, ".slock"));
  writeFileSync(p, token, { mode: 0o600 });
  // Windows 的 writeFileSync mode 只反映到只读位，补一次 chmod 对 POSIX 生效
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort：Windows 上 chmod 可能不支持完整语义，忽略
  }
  return p;
}

/** 删除 token 文件（best-effort，退出清理用——失败不影响退出流程） */
export function removeAgentTokenFile(workspace: string): void {
  try {
    rmSync(agentTokenFilePath(workspace), { force: true });
  } catch {
    // 文件不存在 / 占用等情况忽略：token 已被服务端吊销，死文件无价值
  }
}
