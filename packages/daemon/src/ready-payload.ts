import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeProbe, WsFromDaemonMessage } from "@collabagent/shared";
import { probeRuntimes } from "./drivers/probe.js";

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

export function buildReadyPayload(
  runtimes?: RuntimeProbe[],
  identity?: { machineUuid?: string; serverName?: string },
): Extract<WsFromDaemonMessage, { type: "ready" }> {
  return {
    type: "ready",
    capabilities: ["send", "read"],
    runtimes: runtimes ?? probeRuntimes(),
    hostname: resolveHostname(),
    daemonVersion: readDaemonVersion(),
    os: process.platform,
    arch: process.arch,
    // 2026-09-19 server-scoped computers：本机身份（~/.slock/machine-id）+
    // --server 声明（服务端比对 token scope，不一致拒连）
    ...(identity?.machineUuid ? { machineUuid: identity.machineUuid } : {}),
    ...(identity?.serverName ? { serverName: identity.serverName } : {}),
  };
}
