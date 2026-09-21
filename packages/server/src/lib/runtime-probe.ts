import type { RuntimeEntrypointProbe, RuntimeProbe, RuntimeProbeStatus } from "@collabagent/shared";

const STATUSES = new Set<RuntimeProbeStatus>(["installed", "not_installed", "installed_unsupported"]);

export function normalizeRuntimes(raw: unknown): RuntimeProbe[] {
  if (!Array.isArray(raw)) return [];
  const out: RuntimeProbe[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id) out.push({ id, status: "installed" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const status = STATUSES.has(rec.status as RuntimeProbeStatus)
      ? (rec.status as RuntimeProbeStatus)
      : "not_installed";
    const version = typeof rec.version === "string" && rec.version.trim() ? rec.version.trim() : undefined;
    out.push(version ? { id, status, version } : { id, status });
  }
  return out;
}

// entrypoint 探测的全集状态（含 misconfigured/protocol_incompatible——
// 二进制 runtime 不会发这两个，所以 STATUSES 与 ENTRYPOINT_STATUSES 分开）
const ENTRYPOINT_STATUSES = new Set<RuntimeProbeStatus>([
  "installed",
  "not_installed",
  "installed_unsupported",
  "misconfigured",
  "protocol_incompatible",
]);

const MODEL_MODES = new Set(["fixed", "select"]);

const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Phase 4：ready.entrypoints（manifest entrypoint 探测摘要）归一化。
 * 只保留协议安全面——id/label/status/模型名单/能力；command/cwd/env/secret
 * 从 daemon 侧就不外发，这里再过滤一遍纵深防御。
 */
export function normalizeEntrypoints(raw: unknown): RuntimeEntrypointProbe[] {
  if (!Array.isArray(raw)) return [];
  const out: RuntimeEntrypointProbe[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = optStr(rec.id);
    const label = optStr(rec.label) ?? id;
    if (!id || !label) continue;
    const status = ENTRYPOINT_STATUSES.has(rec.status as RuntimeProbeStatus)
      ? (rec.status as RuntimeProbeStatus)
      : "misconfigured";
    const modelMode = MODEL_MODES.has(rec.modelMode as string) ? (rec.modelMode as "fixed" | "select") : "fixed";
    const models = Array.isArray(rec.models)
      ? rec.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : undefined;
    const ep: RuntimeEntrypointProbe = { id, label, status, modelMode };
    const runtime = optStr(rec.runtime);
    if (runtime) ep.runtime = runtime as RuntimeEntrypointProbe["runtime"];
    const version = optStr(rec.version);
    if (version) ep.version = version;
    if (models) ep.models = models;
    const defaultModel = optStr(rec.defaultModel);
    if (defaultModel) ep.defaultModel = defaultModel;
    if (typeof rec.capabilities === "object" && rec.capabilities !== null && !Array.isArray(rec.capabilities)) {
      ep.capabilities = rec.capabilities as RuntimeEntrypointProbe["capabilities"];
    }
    const errorCode = optStr(rec.errorCode);
    if (errorCode) ep.errorCode = errorCode;
    const errorMessage = optStr(rec.errorMessage);
    if (errorMessage) ep.errorMessage = errorMessage;
    out.push(ep);
  }
  return out;
}

export function runtimeChipLabels(runtimes: RuntimeProbe[]): string[] {
  return runtimes.map((r) => {
    if (r.status === "installed") return r.version ? `${r.id} ${r.version}` : r.id;
    if (r.status === "installed_unsupported") return `${r.id}（未接线）`;
    return `${r.id}（未装）`;
  });
}
