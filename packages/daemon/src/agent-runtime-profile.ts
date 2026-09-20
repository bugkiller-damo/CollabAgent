import { createHash } from "node:crypto";
import type { AgentRuntimeProfile } from "@collabagent/shared";
import type { RuntimeManifestSnapshot } from "./agent-runtime-manifest.js";
import { DispatchError, type DispatchErrorCode } from "./errors.js";

export interface RuntimeProfileIssue {
  code: DispatchErrorCode;
  message: string;
}

export interface AgentRegistrationInfo {
  displayName?: string;
  description?: string;
  model?: string;
  runtime?: string;
  entrypoint?: string;
  runtimeProfileError?: RuntimeProfileIssue | null;
}

export interface ResolvedAgentRuntimeProfile {
  runtime: string;
  model?: string;
  entrypoint?: string;
  identity: string;
  manifestRevision?: string;
  error?: RuntimeProfileIssue;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const identity = (...parts: Array<string | undefined>): string =>
  createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\0"))
    .digest("hex");

const withError = (
  runtime: string,
  model: string | undefined,
  entrypoint: string | undefined,
  snapshot: RuntimeManifestSnapshot,
  code: DispatchErrorCode,
  message: string,
): ResolvedAgentRuntimeProfile => ({
  runtime,
  model,
  entrypoint,
  identity: identity(runtime, model, entrypoint, snapshot.revision, code),
  manifestRevision: snapshot.revision,
  error: { code, message },
});

export function parseAgentRuntimeProfile(value: unknown): AgentRuntimeProfile {
  if (!value) return {};
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  return {
    runtime: typeof record.runtime === "string" ? record.runtime : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    entrypoint: typeof record.entrypoint === "string" ? record.entrypoint : undefined,
  };
}

export function resolveAgentRuntimeProfile(
  info: Pick<AgentRegistrationInfo, "runtime" | "model" | "entrypoint" | "runtimeProfileError">,
  snapshot: RuntimeManifestSnapshot,
): ResolvedAgentRuntimeProfile {
  const runtime = clean(info.runtime)?.toLowerCase() ?? "claude";
  const requestedModel = clean(info.model);
  const entrypoint = clean(info.entrypoint);

  if (info.runtimeProfileError) {
    return withError(
      runtime,
      requestedModel,
      entrypoint,
      snapshot,
      info.runtimeProfileError.code,
      info.runtimeProfileError.message,
    );
  }

  if (runtime === "claude") {
    if (entrypoint) {
      return withError(
        runtime,
        requestedModel,
        entrypoint,
        snapshot,
        "entrypoint-not-allowed",
        "Runtime claude does not accept an entrypoint",
      );
    }
    return { runtime, model: requestedModel, identity: identity(runtime, requestedModel) };
  }

  if (runtime !== "langchain" && runtime !== "langgraph") {
    return {
      runtime,
      model: requestedModel,
      entrypoint,
      identity: identity(runtime, requestedModel, entrypoint),
    };
  }

  if (!entrypoint) {
    return withError(
      runtime,
      requestedModel,
      undefined,
      snapshot,
      "entrypoint-required",
      `Runtime ${runtime} requires an entrypoint`,
    );
  }
  if (snapshot.fatalError) {
    return withError(runtime, requestedModel, entrypoint, snapshot, "manifest-invalid", "Runtime manifest is invalid");
  }
  if (snapshot.invalidEntries.has(entrypoint)) {
    return withError(
      runtime,
      requestedModel,
      entrypoint,
      snapshot,
      "manifest-invalid",
      "Runtime entrypoint is invalid",
    );
  }
  const manifestEntry = snapshot.entries.get(entrypoint);
  if (!manifestEntry) {
    return withError(
      runtime,
      requestedModel,
      entrypoint,
      snapshot,
      "entrypoint-not-found",
      "Runtime entrypoint is not configured",
    );
  }
  if (manifestEntry.runtime !== runtime) {
    return withError(
      runtime,
      requestedModel,
      entrypoint,
      snapshot,
      "entrypoint-runtime-mismatch",
      "Runtime entrypoint does not match the selected runtime",
    );
  }

  const model = requestedModel ?? manifestEntry.model.default;
  if (
    (manifestEntry.model.mode === "fixed" &&
      requestedModel !== undefined &&
      requestedModel !== manifestEntry.model.default) ||
    (manifestEntry.model.mode === "select" && !manifestEntry.model.allowed.includes(model))
  ) {
    return withError(
      runtime,
      requestedModel,
      entrypoint,
      snapshot,
      "model-not-allowed",
      "Model is not allowed by the runtime entrypoint",
    );
  }

  return {
    runtime,
    model,
    entrypoint,
    identity: identity(runtime, model, entrypoint, manifestEntry.revision),
    manifestRevision: manifestEntry.revision,
  };
}

export function assertResolvedAgentRuntimeProfile(profile: ResolvedAgentRuntimeProfile): void {
  if (profile.error) throw new DispatchError(profile.error.code, profile.error.message);
}
