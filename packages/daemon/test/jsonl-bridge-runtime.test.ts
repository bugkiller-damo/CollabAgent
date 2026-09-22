import { describe, expect, it } from "vitest";
import type { AgentRuntimeOpenOptions, AgentRuntimeSession } from "../src/agent-runtime-driver.js";
import type { RuntimeManifestSnapshot } from "../src/agent-runtime-manifest.js";
import { createJsonlBridgeRuntimeDriver } from "../src/drivers/jsonl-bridge-runtime.js";
import type { JsonlWorkerSessionOptions } from "../src/drivers/persistent-jsonl-worker.js";
import { DispatchError } from "../src/errors.js";

/**
 * Phase 2：bridge driver = openSession 规范化选项 → manifest 条目 → spawnSpec
 * 的翻译层。fail-closed：entrypoint 缺失/条目消失/manifest 坏/cwd/command/
 * secretEnv 不合法都在 spawn 前 DispatchError，绝不 spawn 试错。
 */

const entry = (over: Record<string, unknown> = {}) => ({
  id: "ep-1",
  runtime: "langgraph" as const,
  label: "Graph",
  command: "python",
  args: ["-m", "worker"],
  cwd: "/srv/work",
  env: { PYTHONUNBUFFERED: "1" },
  secretEnv: ["OPENAI_API_KEY"],
  secretRefs: [],
  model: { mode: "fixed" as const, default: "gpt-4o", allowed: [] },
  requireDurableThreads: true,
  startupTimeoutMs: 12_000,
  silenceTimeoutMs: 240_000,
  shutdownTimeoutMs: 8_000,
  revision: "r1",
  ...over,
});

const snapshot = (entries: ReturnType<typeof entry>[], fatalError?: string): RuntimeManifestSnapshot => ({
  path: "/x/runtimes.json",
  revision: "rev1",
  entries: new Map(entries.map((e) => [e.id, e])),
  invalidEntries: new Map(),
  ...(fatalError ? { fatalError } : {}),
});

const openOpts = (over: Partial<AgentRuntimeOpenOptions> = {}): AgentRuntimeOpenOptions => ({
  agentName: "researcher",
  mode: "persistent",
  cwd: "/srv/workspace",
  env: { SLOCK_SERVER_URL: "http://s", SLOCK_AGENT_TOKEN_FILE: "/srv/tok" },
  entrypoint: "ep-1",
  model: "gpt-4o",
  agent: { id: "a1", name: "researcher" },
  platformPrompt: "platform",
  mcp: { command: "node", args: ["mcp.cjs"], env: { SLOCK_SERVER_URL: "http://s" } },
  onEvent: () => {},
  ...over,
});

const makeDriver = (snap: RuntimeManifestSnapshot, env: NodeJS.ProcessEnv = {}) => {
  const captured: JsonlWorkerSessionOptions[] = [];
  const fakeSession: AgentRuntimeSession = {
    alive: true,
    send: () => Promise.resolve(),
    stop: () => {},
  };
  const driver = createJsonlBridgeRuntimeDriver({
    manifestLoader: () => snap,
    env: { OPENAI_API_KEY: "sk-test", ...env },
    resolveCommand: (c) => `/bin/${c}`,
    cwdExists: () => true,
    spawnSession: (opts) => {
      captured.push(opts);
      return fakeSession;
    },
  });
  return { driver, captured, fakeSession };
};

describe("createJsonlBridgeRuntimeDriver", () => {
  it("runtimeIds 覆盖 langchain + langgraph", () => {
    const { driver } = makeDriver(snapshot([]));
    expect(driver.runtimeIds).toEqual(["langchain", "langgraph"]);
  });

  it("openSession：manifest 条目 → spawnSpec + 会话选项完整映射", () => {
    const { driver, captured, fakeSession } = makeDriver(snapshot([entry()]));
    const s = driver.openSession(openOpts());
    expect(s).toBe(fakeSession);
    const o = captured[0]!;
    expect(o).toMatchObject({
      agentName: "researcher",
      runtime: "langgraph", // 期望 runtime 以 manifest 条目为准
      entrypoint: "ep-1",
      model: "gpt-4o",
      platformPrompt: "platform",
      workspace: "/srv/workspace",
      serverUrl: "http://s",
      tokenFile: "/srv/tok",
      requireDurableThreads: true,
      timeouts: { startupMs: 12_000, silenceMs: 240_000, shutdownMs: 8_000 },
      mcp: { command: "node" },
      agent: { id: "a1" },
    });
    expect(o.spawnSpec).toMatchObject({ command: "/bin/python", args: ["-m", "worker"], cwd: "/srv/work" });
    // env 合成：manifest env + secretEnv 注入 + 平台 SLOCK_* 变量
    expect(o.spawnSpec.env).toMatchObject({
      PYTHONUNBUFFERED: "1",
      OPENAI_API_KEY: "sk-test",
      SLOCK_SERVER_URL: "http://s",
      SLOCK_AGENT_TOKEN_FILE: "/srv/tok",
    });
  });

  it("平台变量最后胜出：manifest env 不能改投 SLOCK_SERVER_URL", () => {
    const { driver, captured } = makeDriver(snapshot([entry({ env: { SLOCK_SERVER_URL: "http://evil" } })]));
    driver.openSession(openOpts());
    expect(captured[0]!.spawnSpec.env.SLOCK_SERVER_URL).toBe("http://s");
  });

  it("entrypoint 缺失 / 不在 manifest → entrypoint-required / entrypoint-not-found", () => {
    const { driver } = makeDriver(snapshot([entry()]));
    expect(() => driver.openSession(openOpts({ entrypoint: undefined }))).toThrowError(DispatchError);
    try {
      driver.openSession(openOpts({ entrypoint: "nope" }));
      expect.unreachable();
    } catch (e) {
      expect((e as DispatchError).code).toBe("entrypoint-not-found");
      expect((e as DispatchError).retriable).toBe(false);
    }
  });

  it("manifest fatal → manifest-invalid", () => {
    const { driver } = makeDriver(snapshot([], "manifest-invalid"));
    try {
      driver.openSession(openOpts());
      expect.unreachable();
    } catch (e) {
      expect((e as DispatchError).code).toBe("manifest-invalid");
    }
  });

  it("cwd 不存在 / command 解析不到 / secretEnv 缺失 → spawn 前对应错误码", () => {
    const mustNotSpawn = () => {
      throw new Error("must not spawn");
    };
    const badCwd = createJsonlBridgeRuntimeDriver({
      manifestLoader: () => snapshot([entry()]),
      env: { OPENAI_API_KEY: "x" },
      cwdExists: () => false,
      resolveCommand: () => "/bin/python",
      spawnSession: mustNotSpawn,
    });
    try {
      badCwd.openSession(openOpts());
      expect.unreachable();
    } catch (e) {
      expect((e as DispatchError).code).toBe("cwd-not-found");
    }

    const badCmd = createJsonlBridgeRuntimeDriver({
      manifestLoader: () => snapshot([entry()]),
      env: { OPENAI_API_KEY: "x" },
      cwdExists: () => true,
      resolveCommand: () => null,
      spawnSession: mustNotSpawn,
    });
    try {
      badCmd.openSession(openOpts());
      expect.unreachable();
    } catch (e) {
      expect((e as DispatchError).code).toBe("command-not-found");
    }

    const noSecret = createJsonlBridgeRuntimeDriver({
      manifestLoader: () => snapshot([entry()]),
      env: {}, // secretEnv 引用缺失
      cwdExists: () => true,
      resolveCommand: (c) => `/bin/${c}`,
      spawnSession: mustNotSpawn,
    });
    try {
      noSecret.openSession(openOpts());
      expect.unreachable();
    } catch (e) {
      expect((e as DispatchError).code).toBe("secret-env-missing");
      expect((e as DispatchError).message).toContain("OPENAI_API_KEY");
    }
  });

  it("P1.6：mcp 描述符（含 allowTools）原样透传到 worker 会话选项", () => {
    const { driver, captured } = makeDriver(snapshot([entry()]));
    driver.openSession(
      openOpts({
        mcp: {
          transport: "stdio",
          command: "node",
          args: ["mcp.cjs"],
          env: { SLOCK_MCP_TOOL_ALLOWLIST: "send_message" },
          allowTools: ["send_message"],
        },
      }),
    );
    expect(captured[0]!.mcp?.allowTools).toEqual(["send_message"]);
    expect(captured[0]!.mcp?.env?.SLOCK_MCP_TOOL_ALLOWLIST).toBe("send_message");
  });

  it("P1.1 secretRefs：store 缺值 → secret-ref-missing（非 retriable，不 spawn）", () => {
    const mustNotSpawn = () => {
      throw new Error("must not spawn");
    };
    const driver = createJsonlBridgeRuntimeDriver({
      manifestLoader: () => snapshot([entry({ secretRefs: ["STORED_KEY"] })]),
      env: { OPENAI_API_KEY: "x" },
      cwdExists: () => true,
      resolveCommand: (c) => `/bin/${c}`,
      resolveSecretRef: () => undefined,
      spawnSession: mustNotSpawn,
    });
    try {
      driver.openSession(openOpts());
      expect.unreachable();
    } catch (e) {
      expect((e as DispatchError).code).toBe("secret-ref-missing");
      expect((e as DispatchError).retriable).toBe(false);
    }
  });

  it("P1.1 secretRefs：store 有值 → 注入 spawnSpec.env（secretEnv 同层）", () => {
    const captured: JsonlWorkerSessionOptions[] = [];
    const driver = createJsonlBridgeRuntimeDriver({
      manifestLoader: () => snapshot([entry({ secretRefs: ["STORED_KEY"] })]),
      env: { OPENAI_API_KEY: "x" },
      cwdExists: () => true,
      resolveCommand: (c) => `/bin/${c}`,
      resolveSecretRef: (_ep, name) => (name === "STORED_KEY" ? "stored-value" : undefined),
      spawnSession: (opts) => {
        captured.push(opts);
        return { alive: true, send: () => Promise.resolve(), stop: () => {} };
      },
    });
    driver.openSession(openOpts());
    expect(captured[0]!.spawnSpec.env.STORED_KEY).toBe("stored-value");
    expect(captured[0]!.spawnSpec.env.OPENAI_API_KEY).toBe("x");
  });
});
