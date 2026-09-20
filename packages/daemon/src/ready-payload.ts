import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEntrypointProbe, RuntimeProbe, WsFromDaemonMessage } from "@collabagent/shared";
import { loadRuntimeManifest } from "./agent-runtime-manifest.js";
import { loadDaemonEnv } from "./config.js";
import { probeRuntimes } from "./drivers/probe.js";
import { probeRuntimeEntrypoints } from "./drivers/runtime-entrypoint-probe.js";

export function readDaemonVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf-8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    /* fall through */
  }
  return "0.1.0";
}

export function resolveHostname(): string {
  try {
    const h = osHostname();
    if (h && h.trim()) return h.trim();
  } catch {
    /* fall through */
  }
  return process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown";
}

/**
 * Phase 1：bridge runtime entrypoint 探测。`SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1`
 * 时才跑——读本机 manifest 并对每个 entrypoint 执行 `--slock-probe`（失败项
 * 以 misconfigured/not_installed 上抛）。返回 undefined = 未启用，不携带键。
 */
export function probeBridgeEntrypoints(env: NodeJS.ProcessEnv = process.env): RuntimeEntrypointProbe[] | undefined {
  if (!loadDaemonEnv(env).experimentalBridgeRuntimes) return undefined;
  return probeRuntimeEntrypoints(loadRuntimeManifest(undefined, env));
}

export function buildReadyPayload(
  runtimes?: RuntimeProbe[],
  identity?: { machineUuid?: string; serverName?: string },
  entrypoints?: RuntimeEntrypointProbe[],
): Extract<WsFromDaemonMessage, { type: "ready" }> {
  return {
    type: "ready",
    capabilities: ["send", "read"],
    runtimes: runtimes ?? probeRuntimes(),
    hostname: resolveHostname(),
    daemonVersion: readDaemonVersion(),
    os: process.platform,
    arch: process.arch,
    // entrypoints 只含能力摘要（id/label/状态/模型名单），命令/路径/secret 不外发
    ...(entrypoints ? { entrypoints } : {}),
    // 2026-09-19 server-scoped computers：本机身份（~/.slock/machine-id）+
    // --server 声明（服务端比对 token scope，不一致拒连）
    ...(identity?.machineUuid ? { machineUuid: identity.machineUuid } : {}),
    ...(identity?.serverName ? { serverName: identity.serverName } : {}),
  };
}
