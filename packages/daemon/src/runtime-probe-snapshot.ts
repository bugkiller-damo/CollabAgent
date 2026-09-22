/**
 * 批次 B：最近一次 entrypoint probe 结果的落盘快照。
 *
 * `slock runtime list` 需要「manifest + 最近一次 probe 状态」，而 probe 由两条
 * 路径触发：CLI `slock runtime probe|check` 与 daemon 的 manifest watcher
 * （runtime-entrypoint-refresh.ts）。两处都把结果写到 manifest 同目录的
 * `runtime-probe-last.json`——list 读它即可反映最新已知状态，不强迫每次
 * list 都真跑一遍子进程。
 *
 * 内容纪律：只存 probe 安全摘要（与 WS 上报同一形状），不含命令/路径/secret。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeEntrypointProbe } from "@collabagent/shared";
import { mkdirPrivateSync } from "./private-dir.js";

export interface RuntimeProbeSnapshot {
  probedAt: string;
  manifestRevision: string;
  probes: RuntimeEntrypointProbe[];
}

export const runtimeProbeSnapshotPath = (manifestPath: string): string =>
  join(dirname(manifestPath), "runtime-probe-last.json");

export function readRuntimeProbeSnapshot(manifestPath: string): RuntimeProbeSnapshot | null {
  const path = runtimeProbeSnapshotPath(manifestPath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null || !Array.isArray(raw.probes)) return null;
    return {
      probedAt: typeof raw.probedAt === "string" ? raw.probedAt : "",
      manifestRevision: typeof raw.manifestRevision === "string" ? raw.manifestRevision : "",
      probes: raw.probes as RuntimeEntrypointProbe[],
    };
  } catch {
    return null;
  }
}

/** 覆盖写整个快照（probe 全量结果；部分 probe 由调用方先 merge 再传）。 */
export function writeRuntimeProbeSnapshot(manifestPath: string, snapshot: RuntimeProbeSnapshot): void {
  try {
    mkdirPrivateSync(dirname(manifestPath));
    const tmp = `${runtimeProbeSnapshotPath(manifestPath)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    renameSync(tmp, runtimeProbeSnapshotPath(manifestPath));
  } catch (err) {
    console.warn(`[RuntimeProbeSnapshot] persist failed: ${(err as Error)?.message}`);
  }
}

/**
 * 合并写入：以 id 为键把 fresh 里的 probe 覆盖进已有快照（单条 probe / 过滤
 * 子集 probe 时不丢其它条目的旧状态）。
 */
export function mergeRuntimeProbeSnapshot(
  manifestPath: string,
  manifestRevision: string,
  fresh: RuntimeEntrypointProbe[],
): RuntimeProbeSnapshot {
  const prev = readRuntimeProbeSnapshot(manifestPath);
  const byId = new Map<string, RuntimeEntrypointProbe>();
  for (const p of prev?.probes ?? []) byId.set(p.id, p);
  for (const p of fresh) byId.set(p.id, p);
  const next: RuntimeProbeSnapshot = {
    probedAt: new Date().toISOString(),
    manifestRevision,
    probes: [...byId.values()],
  };
  writeRuntimeProbeSnapshot(manifestPath, next);
  return next;
}
