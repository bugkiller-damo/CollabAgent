/**
 * 批次 B（P0.4 + P1.1/P1.2）：`slock runtime` 本地 runtime 管理命令面。
 *
 * 子命令：
 *   list      manifest 条目 + 最近一次 probe 状态（runtime-probe-last.json）
 *   validate  manifest schema/静态校验（复用 validateEntry 权威规则）
 *   probe     对 entrypoint 跑 `--slock-probe`（复用 probeRuntimeEntrypoints）
 *   check     驱动 runSarpConformance 输出结构化报告（默认不跑真实回合，
 *             --run-turns 显式允许后才发 turn.start——可能消费 provider 额度）
 *   add/edit/remove  manifest CRUD（runtime-manifest-manager：原子写 +
 *             validateEntry + revision 审计 + 冲突校验）
 *   secret    本机 secret store 管理（runtime-secret-store：set/unset/list，
 *             list 只回变量名，永不回值）
 *   doctor    批次 C（P1.5）：单 entrypoint 排障面——manifest 条目 +
 *             最近 probe 快照 + 运行诊断（dispatch 最近错误/恢复时间，
 *             含脱敏 stderr 尾）。全本机读取，不触 server 不 spawn。
 *
 * 纪律：
 * - 不接触 server——全部本机操作；server 侧 meta 由 daemon watcher
 *   （runtime-entrypoint-refresh）观察到 revision 迁移后自动刷新；
 * - check 使用临时 workspace（initialize.workspace.path），不注入 live
 *   Slock MCP 写能力（platform:{}），stderr 尾过 redactSecrets 脱敏；
 * - 输出一律 JSON（emit/fail），与既有 cli/* 同约定。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RuntimeEntrypointProbe } from "@collabagent/shared";
import type { Command } from "commander";
import { loadRuntimeManifest } from "../agent-runtime-manifest.js";
import { resolveCommandOnPath } from "../drivers/probe.js";
import { probeRuntimeEntrypoints, type RuntimeEntrypointProbeDeps } from "../drivers/runtime-entrypoint-probe.js";
import { emit, fail } from "../output.js";
import { redactSecrets } from "../redact.js";
import {
  createRuntimeDiagnostics,
  defaultDiagnosticsPath,
  type RuntimeDiagnosticRecord,
} from "../runtime-diagnostics.js";
import { createRuntimeManifestManager, type ManifestMutationResult } from "../runtime-manifest-manager.js";
import { mergeRuntimeProbeSnapshot, readRuntimeProbeSnapshot } from "../runtime-probe-snapshot.js";
import { createRuntimeSecretStore } from "../runtime-secret-store.js";
import { runSarpConformance } from "../sarp-conformance.js";

/* ------------------------------ ops（可测试面） ------------------------------ */

const resolveManifestPath = (opts?: { manifest?: string }): string | undefined => opts?.manifest?.trim() || undefined;

export interface RuntimeListResult {
  ok: boolean;
  path: string;
  revision: string;
  fatalError?: string;
  entries: unknown[];
  invalidEntries: { id: string; code: string; runtime?: string; label?: string }[];
  lastProbe: { probedAt: string; manifestRevision: string } | null;
}

export function runtimeList(opts?: { manifest?: string }): RuntimeListResult {
  const snapshot = loadRuntimeManifest(resolveManifestPath(opts));
  const lastProbe = readRuntimeProbeSnapshot(snapshot.path);
  const probeById = new Map((lastProbe?.probes ?? []).map((p) => [p.id, p]));
  const entries = [...snapshot.entries.values()].map((e) => ({
    id: e.id,
    runtime: e.runtime,
    label: e.label,
    command: e.command,
    args: e.args,
    cwd: e.cwd,
    env: e.env,
    secretEnv: e.secretEnv,
    secretRefs: e.secretRefs,
    model: e.model,
    mcpToolAllowlist: e.mcpToolAllowlist,
    requireDurableThreads: e.requireDurableThreads,
    startupTimeoutMs: e.startupTimeoutMs,
    silenceTimeoutMs: e.silenceTimeoutMs,
    shutdownTimeoutMs: e.shutdownTimeoutMs,
    revision: e.revision,
    probe: probeById.get(e.id) ?? null,
  }));
  const invalidEntries = [...snapshot.invalidEntries.entries()].map(([id, meta]) => ({
    id,
    code: meta.code,
    ...(meta.runtime ? { runtime: meta.runtime } : {}),
    ...(meta.label ? { label: meta.label } : {}),
    probe: probeById.get(id) ?? null,
  }));
  return {
    ok: !snapshot.fatalError && invalidEntries.length === 0,
    path: snapshot.path,
    revision: snapshot.revision,
    ...(snapshot.fatalError ? { fatalError: snapshot.fatalError } : {}),
    entries,
    invalidEntries,
    lastProbe: lastProbe ? { probedAt: lastProbe.probedAt, manifestRevision: lastProbe.manifestRevision } : null,
  };
}

export interface RuntimeValidateResult {
  ok: boolean;
  path: string;
  revision: string;
  valid: number;
  invalid: { id: string; code: string }[];
  fatalError?: string;
}

export function runtimeValidate(opts?: { manifest?: string }): RuntimeValidateResult {
  const snapshot = loadRuntimeManifest(resolveManifestPath(opts));
  const invalid = [...snapshot.invalidEntries.entries()].map(([id, meta]) => ({ id, code: meta.code }));
  return {
    ok: !snapshot.fatalError && invalid.length === 0,
    path: snapshot.path,
    revision: snapshot.revision,
    valid: snapshot.entries.size,
    invalid,
    ...(snapshot.fatalError ? { fatalError: snapshot.fatalError } : {}),
  };
}

export interface RuntimeProbeResult {
  ok: boolean;
  probes: RuntimeEntrypointProbe[];
  probedAt?: string;
}

export function runtimeProbe(
  id: string | undefined,
  opts?: { manifest?: string },
  probeDeps: RuntimeEntrypointProbeDeps = {},
): RuntimeProbeResult {
  const snapshot = loadRuntimeManifest(resolveManifestPath(opts));
  if (snapshot.fatalError) {
    return {
      ok: false,
      probes: [
        {
          id: id ?? "",
          label: "",
          status: "misconfigured",
          modelMode: "fixed",
          errorCode: "manifest-invalid",
          errorMessage: "Runtime manifest is invalid",
        },
      ],
    };
  }
  let probes = probeRuntimeEntrypoints(snapshot, probeDeps);
  if (id) {
    probes = probes.filter((p) => p.id === id);
    if (probes.length === 0) {
      return {
        ok: false,
        probes: [
          {
            id,
            label: id,
            status: "misconfigured",
            modelMode: "fixed",
            errorCode: "entrypoint-not-found",
            errorMessage: `entrypoint "${id}" is not in the manifest`,
          },
        ],
      };
    }
  }
  const stored = mergeRuntimeProbeSnapshot(snapshot.path, snapshot.revision, probes);
  return {
    ok: probes.every((p) => p.status === "installed_unsupported"),
    probes,
    probedAt: stored.probedAt,
  };
}

const cwdExists = (cwd: string): boolean => {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
};

const resolveCommand = (command: string): string | null => {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  return resolveCommandOnPath(command);
};

export interface RuntimeCheckOptions {
  manifest?: string;
  /** true = 发真实 turn.start（可能调 provider）；缺省 false = 只握手/坏帧/关停 */
  runTurns?: boolean;
  model?: string;
  timeoutMs?: number;
  /** 缺省 true（SDK worker 有 journal）；--no-journal → false */
  journal?: boolean;
}

export interface RuntimeCheckResult {
  ok: boolean;
  entrypoint: string;
  checks: { name: string; status: string; detail?: string }[];
  stderrTail?: string;
  skippedTurns: boolean;
}

export async function runtimeCheck(id: string, opts: RuntimeCheckOptions = {}): Promise<RuntimeCheckResult> {
  const snapshot = loadRuntimeManifest(resolveManifestPath(opts));
  if (snapshot.fatalError) {
    fail("manifest-invalid", `runtime manifest is invalid: ${snapshot.fatalError}`);
  }
  const invalid = snapshot.invalidEntries.get(id);
  if (invalid) {
    fail("manifest-invalid", `entrypoint "${id}" failed manifest validation (${invalid.code})`);
  }
  const entry = snapshot.entries.get(id);
  if (!entry) {
    fail("entrypoint-not-found", `entrypoint "${id}" is not in the manifest`);
  }

  // spawn 前静态校验（与 probe/driver 同规则）：cwd → secrets → command。
  if (!cwdExists(entry!.cwd)) {
    fail("cwd-not-found", `entrypoint "${id}": working directory unavailable`);
  }
  const command = resolveCommand(entry!.command);
  if (!command) {
    fail("command-not-found", `entrypoint "${id}": command "${entry!.command}" not found`);
  }
  const secrets: Record<string, string> = {};
  for (const name of entry!.secretEnv) {
    const v = process.env[name];
    if (!v) fail("secret-env-missing", `entrypoint "${id}": secret env "${name}" is not set`);
    secrets[name] = v;
  }
  const secretStore = createRuntimeSecretStore();
  for (const name of entry!.secretRefs) {
    const v = secretStore.get(id, name);
    if (!v) fail("secret-ref-missing", `entrypoint "${id}": secret ref "${name}" is not in the local secret store`);
    secrets[name] = v;
  }

  // 临时 workspace：check 不给 worker 真实 workspace（其内可能有 .slock 状态 /
  // MEMORY.md），initialize.platform:{} 不含 MCP 描述符——不会注入 live
  // Slock MCP 写能力。
  const workspace = mkdtempSync(join(tmpdir(), "slock-runtime-check-"));
  try {
    const report = await runSarpConformance({
      spawnSpec: {
        command: command!,
        args: [...entry!.args],
        cwd: entry!.cwd,
        env: { ...entry!.env, ...secrets },
      },
      runtimeId: entry!.runtime,
      entrypoint: entry!.id,
      ...(opts.model !== undefined ? { expectModel: opts.model } : {}),
      expectJournal: opts.journal !== false,
      skipTurns: opts.runTurns !== true,
      workspacePath: workspace,
      ...(opts.timeoutMs !== undefined ? { stepTimeoutMs: opts.timeoutMs } : {}),
    });
    return {
      ok: report.ok,
      entrypoint: id,
      checks: report.checks.map((c) => ({ name: c.name, status: c.status, ...(c.detail ? { detail: c.detail } : {}) })),
      ...(report.stderrTail ? { stderrTail: redactSecrets(report.stderrTail) } : {}),
      skippedTurns: opts.runTurns !== true,
    };
  } finally {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export interface RuntimeDoctorResult {
  ok: boolean;
  entrypoint: string;
  /** manifest 静态面（含 mcpToolAllowlist；命令/路径只在本地输出——doctor 是本机工具） */
  manifestEntry: Record<string, unknown> | null;
  /** 最近一次 probe 快照中本条目（快照与当前 manifest revision 不符时标 stale） */
  lastProbe: RuntimeEntrypointProbe | null;
  probedAt?: string;
  probeStale?: boolean;
  /** 运行诊断：dispatch 最近错误（含脱敏 stderr 尾）/ 最近成功时间 */
  diagnostics: RuntimeDiagnosticRecord | null;
  issues: string[];
}

export function runtimeDoctor(id: string, opts?: { manifest?: string }): RuntimeDoctorResult {
  const snapshot = loadRuntimeManifest(resolveManifestPath(opts));
  const issues: string[] = [];
  if (snapshot.fatalError) {
    fail("manifest-invalid", `runtime manifest is invalid: ${snapshot.fatalError}`);
  }
  const invalid = snapshot.invalidEntries.get(id);
  const entry = snapshot.entries.get(id);
  if (!entry && !invalid) {
    fail("entrypoint-not-found", `entrypoint "${id}" is not in the manifest`);
  }
  if (invalid) issues.push(`manifest validation failed: ${invalid.code}`);

  // 最近 probe：快照 revision 与当前 manifest 不一致 = 条目改过但还没重测
  const lastProbeFile = readRuntimeProbeSnapshot(snapshot.path);
  const lastProbe = lastProbeFile?.probes.find((p) => p.id === id) ?? null;
  const probeStale = !!lastProbeFile && lastProbeFile.manifestRevision !== snapshot.revision;
  if (!lastProbe) issues.push("no probe snapshot (run `slock runtime probe`)");
  else if (probeStale) issues.push("probe snapshot is stale (manifest changed since)");
  else if (lastProbe.status !== "installed_unsupported") issues.push(`last probe status: ${lastProbe.status}`);

  // 运行诊断（本机 runtime-diagnostics.json；message 落盘前已脱敏，再兜底一次）
  const diag = createRuntimeDiagnostics(defaultDiagnosticsPath()).get(id) ?? null;
  const diagnostics = diag?.lastError
    ? { ...diag, lastError: { ...diag.lastError, message: redactSecrets(diag.lastError.message) } }
    : diag;
  if (diagnostics?.lastError) issues.push(`last dispatch error: ${diagnostics.lastError.code ?? "unknown"}`);

  const manifestEntry = entry
    ? {
        id: entry.id,
        runtime: entry.runtime,
        label: entry.label,
        command: entry.command,
        args: entry.args,
        cwd: entry.cwd,
        env: entry.env,
        secretEnv: entry.secretEnv,
        secretRefs: entry.secretRefs,
        model: entry.model,
        mcpToolAllowlist: entry.mcpToolAllowlist,
        requireDurableThreads: entry.requireDurableThreads,
        startupTimeoutMs: entry.startupTimeoutMs,
        silenceTimeoutMs: entry.silenceTimeoutMs,
        shutdownTimeoutMs: entry.shutdownTimeoutMs,
        revision: entry.revision,
      }
    : null;

  return {
    ok: issues.length === 0,
    entrypoint: id,
    manifestEntry,
    lastProbe,
    ...(lastProbeFile ? { probedAt: lastProbeFile.probedAt } : {}),
    ...(probeStale ? { probeStale } : {}),
    diagnostics,
    issues,
  };
}

export type { ManifestMutationResult };

export function runtimeAdd(rawEntry: unknown, opts?: { manifest?: string }): ManifestMutationResult {
  return createRuntimeManifestManager(resolveManifestPath(opts)).add(rawEntry);
}

export function runtimeEdit(
  id: string,
  patch: Record<string, unknown>,
  opts?: { manifest?: string },
): ManifestMutationResult {
  return createRuntimeManifestManager(resolveManifestPath(opts)).update(id, patch);
}

export function runtimeRemove(id: string, opts?: { manifest?: string }): ManifestMutationResult {
  return createRuntimeManifestManager(resolveManifestPath(opts)).remove(id);
}

/* ------------------------------ CLI 接线 ------------------------------ */

// commander 默认值给 undefined（区分「没给 flag」与「给了空数组」——edit 补丁
// 语义依赖这一点）；首次调用时 prev 即该默认值，故容忍 undefined。
const collect = (value: string, prev?: string[]): string[] => [...(prev ?? []), value];

const parseEnvPairs = (pairs: string[]): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) fail("env-invalid", `--env expects KEY=VALUE, got "${pair}"`);
    env[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return env;
};

interface EntryFlagOpts {
  id?: string;
  runtime?: string;
  label?: string;
  command?: string;
  arg?: string[];
  cwd?: string;
  env?: string[];
  secretEnv?: string[];
  secretRef?: string[];
  model?: string;
  modelMode?: string;
  modelAllowed?: string[];
  mcpTool?: string[];
  durable?: boolean;
  startupTimeout?: string;
  silenceTimeout?: string;
  shutdownTimeout?: string;
}

/** add/edit 共用的 entry 字段装配——只收录用户显式给了的键（edit 语义=补丁）。 */
const buildEntryPatch = (o: EntryFlagOpts): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (o.id !== undefined) patch.id = o.id;
  if (o.runtime !== undefined) patch.runtime = o.runtime;
  if (o.label !== undefined) patch.label = o.label;
  if (o.command !== undefined) patch.command = o.command;
  if (o.arg !== undefined) patch.args = o.arg;
  if (o.cwd !== undefined) patch.cwd = o.cwd;
  if (o.env !== undefined) patch.env = parseEnvPairs(o.env);
  if (o.secretEnv !== undefined) patch.secretEnv = o.secretEnv;
  if (o.secretRef !== undefined) patch.secretRefs = o.secretRef;
  if (o.mcpTool !== undefined) patch.mcpToolAllowlist = o.mcpTool;
  if (o.durable) patch.requireDurableThreads = true;
  const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  if (o.startupTimeout !== undefined) patch.startupTimeoutMs = num(o.startupTimeout);
  if (o.silenceTimeout !== undefined) patch.silenceTimeoutMs = num(o.silenceTimeout);
  if (o.shutdownTimeout !== undefined) patch.shutdownTimeoutMs = num(o.shutdownTimeout);
  if (o.model !== undefined || o.modelMode !== undefined || o.modelAllowed !== undefined) {
    patch.model = {
      ...(o.modelMode !== undefined ? { mode: o.modelMode } : {}),
      ...(o.model !== undefined ? { default: o.model } : {}),
      ...(o.modelAllowed !== undefined ? { allowed: o.modelAllowed } : {}),
    };
  }
  return patch;
};

const addEntryFlags = (cmd: Command, forEdit: boolean): Command => {
  const opt = (flags: string, desc: string): Command =>
    forEdit ? cmd.option(flags, desc) : cmd.requiredOption(flags, desc);
  opt("--id <id>", "entrypoint id (a-z0-9._-, <=64)");
  opt("--runtime <runtime>", "langchain | langgraph");
  opt("--label <label>", "display label");
  opt("--command <command>", "executable command");
  opt("--cwd <dir>", "absolute working directory");
  if (forEdit) opt("--model <model>", "default model id");
  else cmd.requiredOption("--model <model>", "default model id");
  return cmd
    .option("--arg <arg>", "command argument (repeatable)", collect, undefined as unknown as string[])
    .option("--env <pair>", "plain env KEY=VALUE (repeatable)", collect, undefined as unknown as string[])
    .option(
      "--secret-env <name>",
      "env name read from daemon env (repeatable)",
      collect,
      undefined as unknown as string[],
    )
    .option(
      "--secret-ref <name>",
      "env name read from local secret store (repeatable)",
      collect,
      undefined as unknown as string[],
    )
    .option("--model-mode <mode>", "fixed | select")
    .option(
      "--model-allowed <model>",
      "allowed model id for select mode (repeatable)",
      collect,
      undefined as unknown as string[],
    )
    .option(
      "--mcp-tool <name>",
      "MCP tool allowlist entry (repeatable; omit = all platform tools exposed)",
      collect,
      undefined as unknown as string[],
    )
    .option("--durable", "require durable threads (LangGraph checkpoint resume)")
    .option("--startup-timeout <ms>", "startupTimeoutMs 1000-120000")
    .option("--silence-timeout <ms>", "silenceTimeoutMs 1000-3600000")
    .option("--shutdown-timeout <ms>", "shutdownTimeoutMs 100-60000");
};

const emitMutation = (result: ManifestMutationResult): void => {
  if (!result.ok) fail(result.code, result.message);
  emit({ ok: true, data: result });
};

export function registerRuntime(parent: Command) {
  const globals = (cmd: Command): { manifest?: string } => cmd.optsWithGlobals() as { manifest?: string };

  parent.option("--manifest <path>", "override runtime manifest path");

  parent
    .command("list", { isDefault: true })
    .description("List manifest entrypoints + last probe status")
    .action((_opts: unknown, cmd: Command) => {
      emit({ ok: true, data: runtimeList(globals(cmd)) });
    });

  parent
    .command("validate")
    .description("Validate runtime manifest (schema + entry rules)")
    .action((_opts: unknown, cmd: Command) => {
      const result = runtimeValidate(globals(cmd));
      emit({ ok: result.ok, data: result });
      if (!result.ok) process.exitCode = 1;
    });

  parent
    .command("probe [id]")
    .description("Run --slock-probe on entrypoints (all or one)")
    .action((id: string | undefined, _opts: unknown, cmd: Command) => {
      const result = runtimeProbe(id, globals(cmd));
      emit({ ok: result.ok, data: result });
      if (!result.ok) process.exitCode = 1;
    });

  parent
    .command("check <id>")
    .description("Run SARP/1 conformance checks against an entrypoint")
    .option("--run-turns", "start real turns (may call the configured provider / have side effects)")
    .option("--model <model>", "assert ready.model.selected equals this")
    .option("--timeout <ms>", "per-step timeout in ms (default 8000)")
    .option("--no-journal", "worker has no turn journal (skip replay check)")
    .action(
      async (
        id: string,
        o: { runTurns?: boolean; model?: string; timeout?: string; journal?: boolean },
        cmd: Command,
      ) => {
        const result = await runtimeCheck(id, {
          ...globals(cmd),
          runTurns: o.runTurns === true,
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.timeout !== undefined ? { timeoutMs: Number(o.timeout) } : {}),
          journal: o.journal !== false,
        });
        emit({ ok: result.ok, data: result });
        if (!result.ok) process.exitCode = 1;
      },
    );

  addEntryFlags(parent.command("add").description("Add a runtime entrypoint to the local manifest"), false).action(
    (o: EntryFlagOpts, cmd: Command) => {
      // add 语义：model 必须完整给出（model.mode/default 必填——validateEntry 兜底，
      // 但缺 mode 时补 "fixed" 更符合直觉：只给 --model 即 fixed 单模型）。
      const patch = buildEntryPatch(o);
      const model = (patch.model ?? {}) as Record<string, unknown>;
      patch.model = { mode: model.mode ?? "fixed", ...model };
      emitMutation(runtimeAdd(patch, globals(cmd)));
    },
  );

  addEntryFlags(
    parent.command("edit <id>").description("Patch an existing entrypoint (only given flags are applied)"),
    true,
  ).action((id: string, o: EntryFlagOpts, cmd: Command) => {
    emitMutation(runtimeEdit(id, buildEntryPatch(o), globals(cmd)));
  });

  parent
    .command("remove <id>")
    .description("Remove an entrypoint from the local manifest")
    .action((id: string, _opts: unknown, cmd: Command) => {
      emitMutation(runtimeRemove(id, globals(cmd)));
    });

  parent
    .command("doctor <id>")
    .description("Diagnose an entrypoint: manifest entry + last probe + runtime diagnostics")
    .action((id: string, _opts: unknown, cmd: Command) => {
      const result = runtimeDoctor(id, globals(cmd));
      emit({ ok: result.ok, data: result });
      if (!result.ok) process.exitCode = 1;
    });

  const secret = parent.command("secret").description("Local secret store (values never leave this machine)");

  secret
    .command("list [entrypoint]")
    .description("List secret names (never values); no arg = entrypoints that have secrets")
    .action((entrypoint: string | undefined) => {
      const store = createRuntimeSecretStore();
      emit({
        ok: true,
        data: entrypoint
          ? { entrypoint, names: store.listNames(entrypoint) }
          : { entrypoints: store.listEntrypoints() },
      });
    });

  secret
    .command("set <entrypoint> <name>")
    .description("Store a secret value (--value or stdin)")
    .option("--value <value>", "secret value (omit to read from stdin)")
    .action((entrypoint: string, name: string, o: { value?: string }) => {
      let value = o.value;
      if (value === undefined) {
        if (process.stdin.isTTY) fail("secret-value-required", "pass --value or pipe the secret on stdin");
        value = readFileSync(0, "utf-8").replace(/\r?\n$/, "");
      }
      if (!value) fail("secret-value-required", "empty secret value");
      createRuntimeSecretStore().set(entrypoint, name, value);
      emit({ ok: true, data: { entrypoint, name } });
    });

  secret
    .command("unset <entrypoint> <name>")
    .description("Remove a secret")
    .action((entrypoint: string, name: string) => {
      const removed = createRuntimeSecretStore().unset(entrypoint, name);
      emit({ ok: true, data: { entrypoint, name, removed } });
    });
}
