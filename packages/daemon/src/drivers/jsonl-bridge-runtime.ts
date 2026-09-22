/**
 * Phase 2：SARP/1 JSONL bridge runtime driver（langchain / langgraph 共用）。
 * 见 docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md §6/§8/§15。
 *
 * 职责：把 openSession 的规范化选项 + 本机 manifest 条目翻译成
 * PersistentJsonlWorkerSession 的 spawn 配置：
 * - entrypoint ID → manifest 条目（命令/cwd/env/secretEnv/超时）；
 *   server 侧永远只见到稳定 ID，命令不跨进程边界流动。
 * - spawn 前静态 fail-fast：command 解析不到、cwd 不存在、secretEnv 缺失
 *   直接 DispatchError（与 runtime-entrypoint-probe 同规则，不 spawn 试错）。
 * - env 合成：manifest env + secretEnv（按名从 daemon env 取值）+ options.env
 *   （SLOCK_* 平台变量最后胜出——manifest 不能改投 server/token 路径）；
 *   白名单基线由 session 层 applyAgentEnv 统一叠加。
 * - 运行时身份握手校验在 session 层（runtime.id / maxConcurrency /
 *   durableThreads / model override / requestId 回显）。
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BRIDGE_RUNTIME_IDS } from "@collabagent/shared";
import type { AgentRuntimeDriver, AgentRuntimeOpenOptions, AgentRuntimeSession } from "../agent-runtime-driver.js";
import type { RuntimeManifestEntry, RuntimeManifestSnapshot } from "../agent-runtime-manifest.js";
import { DispatchError } from "../errors.js";
import { createRuntimeSecretStore } from "../runtime-secret-store.js";
import { type JsonlWorkerSessionOptions, PersistentJsonlWorkerSession } from "./persistent-jsonl-worker.js";
import { resolveCommandOnPath } from "./probe.js";

export interface JsonlBridgeDriverDeps {
  manifestLoader: () => RuntimeManifestSnapshot;
  /** secretEnv 按名取值的来源；默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 测试注入的会话工厂；默认 PersistentJsonlWorkerSession */
  spawnSession?: (opts: JsonlWorkerSessionOptions) => AgentRuntimeSession;
  resolveCommand?: (command: string) => string | null;
  cwdExists?: (cwd: string) => boolean;
  /** P1.1：secretRefs 的取值源（本机 secret store）；缺省按默认路径建 store */
  resolveSecretRef?: (entrypoint: string, name: string) => string | undefined;
}

const defaultResolveCommand = (command: string): string | null => {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  return resolveCommandOnPath(command);
};

const defaultCwdExists = (cwd: string): boolean => {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
};

/** spawn 前静态校验 + secretEnv 解析（与 probe 同规则；值不落 manifest、不外发） */
const resolveSpawnSpec = (
  entry: RuntimeManifestEntry,
  platformEnv: Record<string, string>,
  sourceEnv: NodeJS.ProcessEnv,
  resolveCommand: (c: string) => string | null,
  cwdExists: (c: string) => boolean,
  resolveSecretRef: (entrypoint: string, name: string) => string | undefined,
): JsonlWorkerSessionOptions["spawnSpec"] => {
  if (!cwdExists(entry.cwd)) {
    throw new DispatchError("cwd-not-found", `entrypoint "${entry.id}": working directory unavailable`);
  }
  const command = resolveCommand(entry.command);
  if (!command) {
    throw new DispatchError("command-not-found", `entrypoint "${entry.id}": command "${entry.command}" not found`);
  }
  const secrets: Record<string, string> = {};
  for (const name of entry.secretEnv) {
    const v = sourceEnv[name];
    if (v === undefined || v === "") {
      throw new DispatchError(
        "secret-env-missing",
        `entrypoint "${entry.id}": required secret env "${name}" is not set on the daemon`,
      );
    }
    secrets[name] = v;
  }
  // P1.1：secretRefs 从本机 store 取值——同 secretEnv 的 fail-fast 规则，
  // 缺失即永久错误（补值后下条消息自然成功，重试无意义）。
  for (const name of entry.secretRefs) {
    const v = resolveSecretRef(entry.id, name);
    if (v === undefined || v === "") {
      throw new DispatchError(
        "secret-ref-missing",
        `entrypoint "${entry.id}": required secret ref "${name}" is not in the local secret store`,
      );
    }
    secrets[name] = v;
  }
  // manifest env → secretEnv → 平台 SLOCK_* 变量（最后胜出：平台不被配置改投）
  return { command, args: [...entry.args], cwd: entry.cwd, env: { ...entry.env, ...secrets, ...platformEnv } };
};

export const createJsonlBridgeRuntimeDriver = (deps: JsonlBridgeDriverDeps): AgentRuntimeDriver => {
  const sourceEnv = deps.env ?? process.env;
  const resolveCommand = deps.resolveCommand ?? defaultResolveCommand;
  const cwdExists = deps.cwdExists ?? defaultCwdExists;
  const resolveSecretRef =
    deps.resolveSecretRef ??
    (() => {
      const store = createRuntimeSecretStore();
      return (entrypoint: string, name: string) => store.get(entrypoint, name);
    })();
  const spawnSession =
    deps.spawnSession ?? ((opts: JsonlWorkerSessionOptions) => new PersistentJsonlWorkerSession(opts));

  return {
    driverId: "jsonl-bridge",
    runtimeIds: BRIDGE_RUNTIME_IDS,

    openSession(options: AgentRuntimeOpenOptions): AgentRuntimeSession {
      // Phase 1 已在 profile resolve 层校验 entrypoint 存在性与 runtime 匹配；
      // driver 再查一次是「最新 manifest」校验——文件可能刚被改（mtime 缓存
      // 会拿到新快照），条目消失/revision 变化要 fail-closed 而非用旧配置。
      if (!options.entrypoint) {
        throw new DispatchError("entrypoint-required", `bridge runtime requires an entrypoint id`);
      }
      const snapshot = deps.manifestLoader();
      if (snapshot.fatalError) {
        throw new DispatchError("manifest-invalid", `runtime manifest invalid: ${snapshot.fatalError}`);
      }
      const entry = snapshot.entries.get(options.entrypoint);
      if (!entry) {
        throw new DispatchError("entrypoint-not-found", `entrypoint "${options.entrypoint}" not in local manifest`);
      }
      const spawnSpec = resolveSpawnSpec(entry, options.env, sourceEnv, resolveCommand, cwdExists, resolveSecretRef);

      return spawnSession({
        agentName: options.agentName,
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        // 握手校验的期望 runtime 以 manifest 条目为准——profile resolve 已保证
        // entry.runtime === profile.runtime（entrypoint-runtime-mismatch）。
        runtime: entry.runtime,
        entrypoint: entry.id,
        // Phase 5 §11.2：entry revision 进 initialize——worker 据此隔离
        // checkpoint 命名空间，manifest 修订后不复用旧 thread。
        revision: entry.revision,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.platformPrompt !== undefined ? { platformPrompt: options.platformPrompt } : {}),
        ...(options.mcp !== undefined ? { mcp: options.mcp } : {}),
        serverUrl: options.env.SLOCK_SERVER_URL,
        tokenFile: options.env.SLOCK_AGENT_TOKEN_FILE,
        workspace: options.cwd,
        requireDurableThreads: entry.requireDurableThreads,
        spawnSpec,
        timeouts: {
          startupMs: entry.startupTimeoutMs,
          silenceMs: entry.silenceTimeoutMs,
          shutdownMs: entry.shutdownTimeoutMs,
        },
        onEvent: options.onEvent,
        ...(options.onExit !== undefined ? { onExit: options.onExit } : {}),
      });
    },

    forgetAgent(_agentName: string): void {
      // driver 无 per-agent 累积状态——会话生命周期由 dispatch 层管
      // （persistentSessions / sessionIdentities / interruptStore）。
    },
  };
};
