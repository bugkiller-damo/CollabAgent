import type {
  PendingInterruptSummary,
  RuntimeEntrypointProbe,
  RuntimeProbe,
  RuntimeProbeStatus,
} from "@collabagent/shared";

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
    // 批次 C（P1.5）：运行诊断摘要——白名单字段（lastError{code,message,at}/
    // lastOkAt），其余一律剥离（防御：上游若误带命令/env 在此被剥掉）。
    if (typeof rec.diagnostics === "object" && rec.diagnostics !== null && !Array.isArray(rec.diagnostics)) {
      const d = rec.diagnostics as Record<string, unknown>;
      const diag: NonNullable<RuntimeEntrypointProbe["diagnostics"]> = {};
      const lastError =
        typeof d.lastError === "object" && d.lastError !== null ? (d.lastError as Record<string, unknown>) : null;
      if (lastError) {
        const message = optStr(lastError.message);
        const at = optStr(lastError.at);
        if (message && at) {
          diag.lastError = {
            message: message.slice(0, 600),
            at,
            ...(optStr(lastError.code) ? { code: optStr(lastError.code) } : {}),
          };
        }
      }
      const lastOkAt = optStr(d.lastOkAt);
      if (lastOkAt) diag.lastOkAt = lastOkAt;
      if (diag.lastError || diag.lastOkAt) ep.diagnostics = diag;
    }
    out.push(ep);
  }
  return out;
}

const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * 批次 C（P1.4）：interrupts:state 的 pending 摘要归一化。daemon 契约上
 * 不含 resumeToken，这里仍按白名单字段重建——纵深防御：任何协议外字段
 * （含万一误发的 resumeToken）都被剥掉，browser/DB 只见安全摘要。
 */
export function normalizeInterrupts(raw: unknown): PendingInterruptSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingInterruptSummary[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const agentId = optStr(rec.agentId);
    const conversationId = optStr(rec.conversationId);
    const interruptId = optStr(rec.interruptId);
    const prompt = optStr(rec.prompt) ?? "";
    const createdAt = optNum(rec.createdAt);
    const expiresAt = optNum(rec.expiresAt);
    if (!agentId || !conversationId || !interruptId || createdAt === undefined || expiresAt === undefined) continue;
    const summary: PendingInterruptSummary = { agentId, conversationId, interruptId, prompt, createdAt, expiresAt };
    const agentName = optStr(rec.agentName);
    if (agentName) summary.agentName = agentName;
    const runtime = optStr(rec.runtime);
    if (runtime) summary.runtime = runtime;
    const channel = optStr(rec.channel);
    if (channel) summary.channel = channel;
    const threadId = optStr(rec.threadId);
    if (threadId) summary.threadId = threadId;
    out.push(summary);
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
