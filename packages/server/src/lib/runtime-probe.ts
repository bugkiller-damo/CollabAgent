import type { RuntimeProbe, RuntimeProbeStatus } from "@collabagent/shared";

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

export function runtimeChipLabels(runtimes: RuntimeProbe[]): string[] {
  return runtimes.map((r) => {
    if (r.status === "installed") return r.version ? `${r.id} ${r.version}` : r.id;
    if (r.status === "installed_unsupported") return `${r.id}（未接线）`;
    return `${r.id}（未装）`;
  });
}
