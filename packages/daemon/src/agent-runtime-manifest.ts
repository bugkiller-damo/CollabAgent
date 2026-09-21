import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BridgeRuntimeId } from "@collabagent/shared";
import { loadDaemonEnv } from "./config.js";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";

export type { BridgeRuntimeId };
export type RuntimeModelMode = "fixed" | "select";

export interface RuntimeManifestEntry {
  id: string;
  runtime: BridgeRuntimeId;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  secretEnv: string[];
  model: { mode: RuntimeModelMode; default: string; allowed: string[] };
  requireDurableThreads: boolean;
  startupTimeoutMs: number;
  silenceTimeoutMs: number;
  shutdownTimeoutMs: number;
  revision: string;
}

/** 校验失败的 manifest 条目：保留可安全外发的元数据（ready probe 展示用，不含命令/路径/secret） */
export interface InvalidManifestEntry {
  code: string;
  runtime?: BridgeRuntimeId;
  label?: string;
}

export interface RuntimeManifestSnapshot {
  path: string;
  revision: string;
  entries: ReadonlyMap<string, RuntimeManifestEntry>;
  invalidEntries: ReadonlyMap<string, InvalidManifestEntry>;
  fatalError?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_OPERATOR_RE = /[;&|`<>]/;
const DANGEROUS_ENV = new Set(["NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]);
const CREDENTIAL_ENV_RE = /(^|_)(TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)($|_)/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const boundedInt = (value: unknown, fallback: number, min: number, max: number): number | null => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
};

const invalidSnapshot = (path: string, revision: string): RuntimeManifestSnapshot => ({
  path,
  revision,
  entries: new Map(),
  invalidEntries: new Map(),
  fatalError: "manifest-invalid",
});

export function defaultRuntimeManifestPath(): string {
  return join(slockDir(), "runtimes.json");
}

export function resolveRuntimeManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = loadDaemonEnv(env).runtimeManifestPath;
  return configured ? resolve(configured) : defaultRuntimeManifestPath();
}

interface ValidatedEntry {
  entry?: Omit<RuntimeManifestEntry, "revision">;
  id?: string;
  runtime?: BridgeRuntimeId;
  label?: string;
  error?: string;
}

function validateEntry(raw: unknown): ValidatedEntry {
  if (!isRecord(raw)) return { error: "entry-invalid" };
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
  const id = ID_RE.test(rawId) ? rawId : undefined;
  const runtime = raw.runtime === "langchain" || raw.runtime === "langgraph" ? raw.runtime : undefined;
  const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";
  const label = rawLabel && rawLabel.length <= 80 ? rawLabel : undefined;
  if (!id) return { runtime, label, error: "entry-id-invalid" };
  if (!runtime) return { id, label, error: "entry-runtime-invalid" };
  if (!label) return { id, runtime, error: "entry-label-invalid" };

  const fail = (error: string): ValidatedEntry => ({ id, runtime, label, error });

  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command || command.includes("\0") || /[\r\n]/.test(command) || SHELL_OPERATOR_RE.test(command)) {
    return fail("entry-command-invalid");
  }

  const args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.length > 128) return fail("entry-args-invalid");
    for (const arg of raw.args) {
      if (typeof arg !== "string" || arg.length > 4096 || arg.includes("\0") || /[\r\n]/.test(arg)) {
        return fail("entry-args-invalid");
      }
      args.push(arg);
    }
  }

  const cwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
  if (!cwd || !isAbsolute(cwd)) return fail("entry-cwd-invalid");

  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) return fail("entry-env-invalid");
    for (const [key, value] of Object.entries(raw.env)) {
      const upper = key.toUpperCase();
      if (
        !ENV_RE.test(key) ||
        typeof value !== "string" ||
        value.length > 16_384 ||
        upper.startsWith("SLOCK_") ||
        DANGEROUS_ENV.has(upper) ||
        CREDENTIAL_ENV_RE.test(upper)
      ) {
        return fail("entry-env-invalid");
      }
      env[key] = value;
    }
  }

  const secretEnv: string[] = [];
  if (raw.secretEnv !== undefined) {
    if (!Array.isArray(raw.secretEnv)) return fail("entry-secret-env-invalid");
    const seen = new Set<string>();
    for (const value of raw.secretEnv) {
      if (typeof value !== "string" || !ENV_RE.test(value)) return fail("entry-secret-env-invalid");
      const upper = value.toUpperCase();
      if (upper.startsWith("SLOCK_") || DANGEROUS_ENV.has(upper) || seen.has(upper)) {
        return fail("entry-secret-env-invalid");
      }
      if (Object.keys(env).some((key) => key.toUpperCase() === upper)) return fail("entry-env-overlap");
      seen.add(upper);
      secretEnv.push(value);
    }
  }

  if (!isRecord(raw.model)) return fail("entry-model-invalid");
  const mode = raw.model.mode;
  const defaultModel = typeof raw.model.default === "string" ? raw.model.default.trim() : "";
  if ((mode !== "fixed" && mode !== "select") || !defaultModel) return fail("entry-model-invalid");
  const allowedRaw = raw.model.allowed;
  if (allowedRaw !== undefined && !Array.isArray(allowedRaw)) return fail("entry-model-invalid");
  const allowed = [
    ...new Set(
      (Array.isArray(allowedRaw) ? allowedRaw : [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (mode === "select" && (allowed.length === 0 || !allowed.includes(defaultModel))) {
    return fail("entry-model-invalid");
  }

  const startupTimeoutMs = boundedInt(raw.startupTimeoutMs, 15_000, 1_000, 120_000);
  const silenceTimeoutMs = boundedInt(raw.silenceTimeoutMs, 300_000, 1_000, 3_600_000);
  const shutdownTimeoutMs = boundedInt(raw.shutdownTimeoutMs, 10_000, 100, 60_000);
  if (startupTimeoutMs == null || silenceTimeoutMs == null || shutdownTimeoutMs == null) {
    return fail("entry-timeout-invalid");
  }
  if (raw.requireDurableThreads !== undefined && typeof raw.requireDurableThreads !== "boolean") {
    return fail("entry-durable-invalid");
  }

  return {
    id,
    runtime,
    label,
    entry: {
      id,
      runtime,
      label,
      command,
      args,
      cwd,
      env,
      secretEnv,
      model: { mode, default: defaultModel, allowed: mode === "fixed" ? [] : allowed },
      requireDurableThreads: raw.requireDurableThreads === true,
      startupTimeoutMs,
      silenceTimeoutMs,
      shutdownTimeoutMs,
    },
  };
}

export function loadRuntimeManifest(filePath?: string, env: NodeJS.ProcessEnv = process.env): RuntimeManifestSnapshot {
  const path = resolve(filePath ?? resolveRuntimeManifestPath(env));
  if (!existsSync(path)) {
    return { path, revision: "missing", entries: new Map(), invalidEntries: new Map() };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  } catch {
    return invalidSnapshot(path, "unreadable");
  }

  const revision = sha256(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidSnapshot(path, revision);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return invalidSnapshot(path, revision);
  }

  const entries = new Map<string, RuntimeManifestEntry>();
  const invalidEntries = new Map<string, InvalidManifestEntry>();
  parsed.entries.forEach((rawEntry, index) => {
    const validated = validateEntry(rawEntry);
    const key = validated.id ?? `#${index}`;
    const meta: InvalidManifestEntry = { code: "entry-invalid" };
    if (validated.runtime) meta.runtime = validated.runtime;
    if (validated.label) meta.label = validated.label;
    if (!validated.entry) {
      meta.code = validated.error ?? "entry-invalid";
      invalidEntries.set(key, meta);
      return;
    }
    if (entries.has(validated.entry.id) || invalidEntries.has(validated.entry.id)) {
      entries.delete(validated.entry.id);
      invalidEntries.set(validated.entry.id, { ...meta, code: "entry-id-duplicate" });
      return;
    }
    const normalized = validated.entry;
    entries.set(normalized.id, { ...normalized, revision: sha256(JSON.stringify(normalized)) });
  });

  return { path, revision, entries, invalidEntries };
}

/**
 * Phase 5 §16.2.10：manifest 审计日志。revision 变化时向 manifest 同目录的
 * `runtime-manifest-audit.jsonl` 追加一行——只记安全元数据（时间/新旧
 * revision/条目 id+runtime+条目 revision/校验失败码），不记 command/cwd/
 * env 值/secret 名之外的任何配置内容。审计写失败不阻断 manifest 加载。
 */
export const manifestAuditPath = (manifestPath: string): string =>
  join(dirname(manifestPath), "runtime-manifest-audit.jsonl");

const appendManifestAudit = (prev: RuntimeManifestSnapshot | null, next: RuntimeManifestSnapshot): void => {
  const line = {
    ts: new Date().toISOString(),
    manifest: next.path,
    previousRevision: prev?.revision ?? null,
    revision: next.revision,
    fatalError: next.fatalError,
    entries: [...next.entries.values()].map((e) => ({ id: e.id, runtime: e.runtime, revision: e.revision })),
    invalidEntries: [...next.invalidEntries.entries()].map(([id, e]) => ({ id, code: e.code, runtime: e.runtime })),
  };
  try {
    mkdirPrivateSync(dirname(next.path));
    appendFileSync(manifestAuditPath(next.path), `${JSON.stringify(line)}\n`, "utf-8");
  } catch (err) {
    console.warn(`[ManifestAudit] append failed: ${(err as Error)?.message}`);
  }
};

/**
 * Phase 1：manifest 的 mtime 缓存加载器。文件未变 → 复用上份 snapshot；
 * 变更 → 重新解析（revision/条目修订随内容变化，下游据此失效旧会话）。
 * Phase 5：revision 变化（含首次加载 missing→有内容、以及文件消失/损坏）
 * 追加一条审计行；同 revision 的重复加载不产生重复审计记录。
 * 返回零参函数便于作为依赖注入 dispatch / ready 链路。
 */
export function createRuntimeManifestLoader(
  filePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): () => RuntimeManifestSnapshot {
  let cacheKey: string | null = null;
  let cached: RuntimeManifestSnapshot | null = null;
  return () => {
    const path = resolve(filePath ?? resolveRuntimeManifestPath(env));
    let statKey = "unavailable";
    try {
      const st = statSync(path);
      statKey = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* 缺失/不可读也照常走 loadRuntimeManifest，由它给出 missing/invalid 语义 */
    }
    const key = `${path}\n${statKey}`;
    if (cached && cacheKey === key) return cached;
    const next = loadRuntimeManifest(path, env);
    // 审计纪律：「文件 stat 变了但解析结果 revision 没变」不写——mtime 抖动
    // （touch / 权限位变更）不该制造假变更记录。首次加载也不写（无变更语义，
    // 初始状态是基线而非变更）。审计只记真正的 revision 迁移。
    if (cached && cached.revision !== next.revision) appendManifestAudit(cached, next);
    cached = next;
    cacheKey = key;
    return cached;
  };
}
