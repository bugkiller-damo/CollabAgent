import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirPrivateSync } from "./private-dir.js";

/**
 * 2026-09-19 server-scoped computers：本机稳定身份。
 *
 * machineUuid 是「这台物理机」在 server 侧 computers 表里的身份键
 * （UNIQUE(user_id, server_id, machine_uuid)），daemon 每次 ready 上报——
 * 同一台机器无论换连哪个 server、重启多少次，身份必须不变，否则一台物理机
 * 会在同一 server 里堆出多行计算机记录。
 *
 * 存到 ~/.slock/machine-id（OS 用户主目录）而非 cwd/.slock：cwd 下的 .slock
 * 是 daemon 的「部署态」（workspaces/会话/成本），换目录启动属于新部署；
 * 但机器身份属于硬件——换 cwd 运行还是同一台电脑，不能裂成两行。
 *
 * 解析优先级：显式 override（DaemonConfig.machineUuid，测试注入）>
 * SLOCK_MACHINE_ID 环境变量（容器/多实例手工指定）> 持久化文件 > 新生成。
 */
export function defaultMachineIdPath(): string {
  return join(homedir(), ".slock", "machine-id");
}

const MAX_LEN = 128;

function normalize(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s && s.length <= MAX_LEN ? s : null;
}

export function resolveMachineUuid(override?: string, filePath: string = defaultMachineIdPath()): string {
  const fromOverride = normalize(override);
  if (fromOverride) return fromOverride;
  const fromEnv = normalize(process.env.SLOCK_MACHINE_ID);
  if (fromEnv) return fromEnv;
  try {
    const existing = normalize(readFileSync(filePath, "utf-8"));
    if (existing) return existing;
  } catch {
    /* 文件不存在/不可读 → 走生成 */
  }
  const generated = randomUUID();
  try {
    mkdirPrivateSync(dirname(filePath));
    writeFileSync(filePath, generated, { mode: 0o600 });
  } catch (err) {
    // 写不进盘不代表不能跑——只是本进程身份不持久，下次启动换新身份
    // （computers 表会多出一行，属于可接受降级，日志告知即可）
    console.warn("[Daemon] machine-id 落盘失败，本次运行使用临时身份:", err instanceof Error ? err.message : err);
  }
  return generated;
}
