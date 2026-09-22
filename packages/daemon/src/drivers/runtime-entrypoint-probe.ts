import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import type { RuntimeCapabilityProbe, RuntimeEntrypointProbe } from "@collabagent/shared";
import { buildAgentEnv } from "../agent-env-whitelist.js";
import type { RuntimeManifestEntry, RuntimeManifestSnapshot } from "../agent-runtime-manifest.js";
import { createRuntimeSecretStore } from "../runtime-secret-store.js";
import { resolveCommandOnPath } from "./probe.js";

export interface RuntimeEntrypointProbeDeps {
  env?: NodeJS.ProcessEnv;
  resolveCommand?: (command: string) => string | null;
  cwdExists?: (cwd: string) => boolean;
  execute?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; encoding: "utf-8"; timeout: number; windowsHide: true },
  ) => string;
  /** P1.1：secretRefs 的取值源（本机 secret store）；缺省按默认路径建 store */
  resolveSecretRef?: (entrypoint: string, name: string) => string | undefined;
}

const fixedError = (
  entry: RuntimeManifestEntry,
  status: RuntimeEntrypointProbe["status"],
  errorCode: string,
  errorMessage: string,
): RuntimeEntrypointProbe => ({
  id: entry.id,
  runtime: entry.runtime,
  label: entry.label,
  status,
  modelMode: entry.model.mode,
  models: entry.model.mode === "fixed" ? [entry.model.default] : [...entry.model.allowed],
  defaultModel: entry.model.default,
  errorCode,
  errorMessage,
});

const sanitizeCapabilities = (value: unknown): RuntimeCapabilityProbe | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.maxConcurrency !== 1) return null;
  const output: RuntimeCapabilityProbe = { maxConcurrency: 1 };
  for (const key of [
    "persistentProcess",
    "streamingText",
    "toolEvents",
    "durableThreads",
    "interrupts",
    "mcp",
    "pty",
  ] as const) {
    if (typeof input[key] === "boolean") output[key] = input[key];
  }
  if (input.usage === "none" || input.usage === "tokens" || input.usage === "cost") output.usage = input.usage;
  return output;
};

const defaultCwdExists = (cwd: string): boolean => {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
};

const defaultResolveCommand = (command: string): string | null => {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  return resolveCommandOnPath(command);
};

const defaultExecute: NonNullable<RuntimeEntrypointProbeDeps["execute"]> = (command, args, options) =>
  execFileSync(command, args, options);

export function probeRuntimeEntrypoints(
  snapshot: RuntimeManifestSnapshot,
  deps: RuntimeEntrypointProbeDeps = {},
): RuntimeEntrypointProbe[] {
  if (snapshot.fatalError) return [];
  const sourceEnv = deps.env ?? process.env;
  const resolveCommand = deps.resolveCommand ?? defaultResolveCommand;
  const cwdExists = deps.cwdExists ?? defaultCwdExists;
  const execute = deps.execute ?? defaultExecute;
  // P1.1：缺省取值源是本机 secret store（每次调用建一次 store 实例——内部
  // 每次 get 重读文件，天然拿到 CRUD 后最新值）。
  const resolveSecretRef =
    deps.resolveSecretRef ??
    (() => {
      const store = createRuntimeSecretStore();
      return (entrypoint: string, name: string) => store.get(entrypoint, name);
    })();
  const probes: RuntimeEntrypointProbe[] = [];

  for (const entry of snapshot.entries.values()) {
    if (!cwdExists(entry.cwd)) {
      probes.push(
        fixedError(entry, "misconfigured", "cwd-not-found", "Runtime entrypoint working directory is unavailable"),
      );
      continue;
    }
    if (entry.secretEnv.some((name) => !sourceEnv[name])) {
      probes.push(
        fixedError(entry, "misconfigured", "secret-env-missing", "Runtime entrypoint is missing a required secret"),
      );
      continue;
    }
    if (entry.secretRefs.some((name) => !resolveSecretRef(entry.id, name))) {
      probes.push(
        fixedError(
          entry,
          "misconfigured",
          "secret-ref-missing",
          "Runtime entrypoint is missing a required secret from the local secret store",
        ),
      );
      continue;
    }
    const command = resolveCommand(entry.command);
    if (!command) {
      probes.push(
        fixedError(entry, "not_installed", "command-not-found", "Runtime entrypoint command is not installed"),
      );
      continue;
    }
    if (/^\.(cmd|bat)$/i.test(extname(command))) {
      probes.push(
        fixedError(
          entry,
          "protocol_incompatible",
          "command-wrapper-unsupported",
          "Runtime entrypoint command must be a directly executable file",
        ),
      );
      continue;
    }

    let stdout: string;
    try {
      // secretEnv 只传变量名声明过的值——从 daemon 进程 env 按名取值注入子进程，
      // manifest 里绝不出现明文 secret（与 spawn 语义一致）。
      const secrets: Record<string, string> = {};
      for (const name of entry.secretEnv) {
        const v = sourceEnv[name];
        if (v !== undefined) secrets[name] = v;
      }
      // secretRefs：本机 store 取值按名注入（同 secretEnv 纪律——值不外发）。
      for (const name of entry.secretRefs) {
        const v = resolveSecretRef(entry.id, name);
        if (v !== undefined) secrets[name] = v;
      }
      stdout = execute(command, [...entry.args, "--slock-probe"], {
        cwd: entry.cwd,
        env: buildAgentEnv({ ...entry.env, ...secrets }, sourceEnv),
        encoding: "utf-8",
        timeout: Math.min(entry.startupTimeoutMs, 15_000),
        windowsHide: true,
      });
    } catch {
      probes.push(fixedError(entry, "misconfigured", "probe-failed", "Runtime entrypoint probe failed"));
      continue;
    }

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length !== 1) {
      probes.push(
        fixedError(
          entry,
          "protocol_incompatible",
          "probe-output-invalid",
          "Runtime entrypoint returned an invalid probe frame",
        ),
      );
      continue;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(lines[0]!);
    } catch {
      frame = null;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      probes.push(
        fixedError(
          entry,
          "protocol_incompatible",
          "probe-output-invalid",
          "Runtime entrypoint returned an invalid probe frame",
        ),
      );
      continue;
    }
    const record = frame as Record<string, unknown>;
    const runtime =
      typeof record.runtime === "object" && record.runtime !== null && !Array.isArray(record.runtime)
        ? (record.runtime as Record<string, unknown>)
        : null;
    const capabilities = sanitizeCapabilities(record.capabilities);
    if (
      record.protocol !== "slock.agent-runtime" ||
      record.version !== 1 ||
      record.type !== "probe.result" ||
      runtime?.id !== entry.runtime ||
      !capabilities
    ) {
      probes.push(
        fixedError(
          entry,
          "protocol_incompatible",
          "probe-protocol-incompatible",
          "Runtime entrypoint probe protocol is incompatible",
        ),
      );
      continue;
    }

    const bridgeVersion = typeof runtime.bridgeVersion === "string" ? runtime.bridgeVersion.trim() : "";
    const frameworkVersion = typeof runtime.frameworkVersion === "string" ? runtime.frameworkVersion.trim() : "";
    probes.push({
      id: entry.id,
      runtime: entry.runtime,
      label: entry.label,
      status: "installed_unsupported",
      ...(bridgeVersion || frameworkVersion ? { version: bridgeVersion || frameworkVersion } : {}),
      models: entry.model.mode === "fixed" ? [entry.model.default] : [...entry.model.allowed],
      defaultModel: entry.model.default,
      modelMode: entry.model.mode,
      capabilities,
    });
  }

  // manifest 校验失败的条目也以 misconfigured 上抛——用户能在 server 端看到
  // 「配置了但没生效」而不是静默消失。只外发 id/label/runtime/errorCode，
  // 命令、路径、env、secret 名一律不出 daemon 进程。
  for (const [id, meta] of snapshot.invalidEntries) {
    if (id.startsWith("#")) continue; // 连合法 id 都没有的畸形行无法定位，跳过
    probes.push({
      id,
      ...(meta.runtime ? { runtime: meta.runtime } : {}),
      label: meta.label ?? id,
      status: "misconfigured",
      modelMode: "fixed",
      models: [],
      errorCode: meta.code,
      errorMessage: "Runtime entrypoint manifest configuration is invalid",
    });
  }

  return probes;
}
