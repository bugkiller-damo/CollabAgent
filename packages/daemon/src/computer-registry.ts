import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirPrivateSync } from "./private-dir.js";

/**
 * `slock computer` 的 server 接入档案：name → { serverUrl, apiKey, ... }。
 *
 * 存 `~/.slock/servers.json`（0600）而非 cwd 的 `.slock/`——与 machine-id.ts
 * 同决策：server 绑定是「这台物理机」级资产，换目录启动 / 换部署目录不该
 * 丢登记；apiKey 是 sk_machine_ 账号级全权令牌，0600 + 私有目录是必须项。
 *
 * 文件格式即顶层 Record<name, ComputerProfile>（无 envelope）——单机几十条
 * 以内的手工编辑友好结构；损坏 JSON 一律按空表处理（load 不抛）。
 */

export interface ComputerProfile {
  /** daemon WS/REST 目标（http→ws / https→wss 由 daemon-core 映射） */
  serverUrl: string;
  /** sk_machine_ 账号级机器令牌（web 端 /computers 签发） */
  apiKey: string;
  /** 显式机器身份（--machine <uuid>），透传 SLOCK_MACHINE_ID；缺省走 ~/.slock/machine-id 自动生成 */
  machineUuid?: string;
  /** 显式状态目录（透传 SLOCK_STATE_DIR）；缺省 = <daemonRoot>/.slock（沿用 cwd 部署态语义） */
  stateDir?: string;
  /** setup 时解析到的 daemon 包根（src/supervisor.ts 所在包根）；cli 打 bundle 后靠它找回入口 */
  daemonRoot?: string;
  enrolledAt: string;
}

export type ComputerProfiles = Record<string, ComputerProfile>;

export const defaultComputerRegistryPath = (): string => join(homedir(), ".slock", "servers.json");

/** raft 手感："/name" 与 "name" 等价；空/未给 → ""。 */
export const normalizeServerName = (raw: string | undefined | null): string => (raw ?? "").trim().replace(/^\/+/, "");

export function loadComputerProfiles(path: string = defaultComputerRegistryPath()): ComputerProfiles {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: ComputerProfiles = {};
    for (const [name, p] of Object.entries(raw as Record<string, unknown>)) {
      const prof = p as ComputerProfile;
      if (prof && typeof prof.serverUrl === "string" && typeof prof.apiKey === "string") {
        out[name] = prof;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeProfiles(path: string, profiles: ComputerProfiles): void {
  mkdirPrivateSync(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveComputerProfile(
  name: string,
  profile: ComputerProfile,
  path: string = defaultComputerRegistryPath(),
): void {
  const profiles = loadComputerProfiles(path);
  profiles[name] = profile;
  writeProfiles(path, profiles);
}

export function removeComputerProfile(name: string, path: string = defaultComputerRegistryPath()): boolean {
  const profiles = loadComputerProfiles(path);
  if (!(name in profiles)) return false;
  delete profiles[name];
  writeProfiles(path, profiles);
  return true;
}
