import { describe, expect, it, vi } from "vitest";
import type { RuntimeManifestEntry, RuntimeManifestSnapshot } from "../src/agent-runtime-manifest.js";
import { probeRuntimeEntrypoints } from "../src/drivers/runtime-entrypoint-probe.js";

/**
 * Phase 1：entrypoint probe 的安全契约——所有系统侧行为（命令解析、cwd 检查、
 * 子进程执行）经 deps 注入；probe 结果只含能力摘要，绝不外发命令/路径/secret。
 */

const entry = (over: Partial<RuntimeManifestEntry> = {}): RuntimeManifestEntry => ({
  id: "ep-1",
  runtime: "langgraph",
  label: "Test Graph",
  command: "python",
  args: ["-m", "worker"],
  cwd: "/tmp/work",
  env: { PLAIN_FLAG: "1" },
  secretEnv: ["OPENAI_API_KEY"],
  secretRefs: [],
  model: { mode: "select", default: "a", allowed: ["a", "b"] },
  requireDurableThreads: false,
  startupTimeoutMs: 15_000,
  silenceTimeoutMs: 300_000,
  shutdownTimeoutMs: 10_000,
  revision: "rev",
  ...over,
});

const manifest = (
  entries: RuntimeManifestEntry[] = [],
  invalidEntries: [string, { code: string; runtime?: "langchain" | "langgraph"; label?: string }][] = [],
  fatalError?: string,
): RuntimeManifestSnapshot => ({
  path: "<test>",
  revision: "rev",
  entries: new Map(entries.map((e) => [e.id, e])),
  invalidEntries: new Map(invalidEntries),
  ...(fatalError ? { fatalError } : {}),
});

const goodFrame = JSON.stringify({
  protocol: "slock.agent-runtime",
  version: 1,
  type: "probe.result",
  runtime: { id: "langgraph", bridgeVersion: "0.1.0", frameworkVersion: "0.2.0" },
  capabilities: { maxConcurrency: 1, persistentProcess: true, streamingText: true, usage: "tokens", bogus: "dropped" },
});

const deps = (over: Partial<Parameters<typeof probeRuntimeEntrypoints>[1]> = {}) => ({
  env: { OPENAI_API_KEY: "sk-live", PATH: process.env.PATH } as NodeJS.ProcessEnv,
  resolveCommand: () => "/usr/bin/python",
  cwdExists: () => true,
  execute: vi.fn(() => goodFrame),
  ...over,
});

describe("probeRuntimeEntrypoints", () => {
  it("fatalError manifest → 不探测，返回空", () => {
    const execute = vi.fn();
    expect(probeRuntimeEntrypoints(manifest([entry()], [], "manifest-invalid"), { execute })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("probe 成功 → installed_unsupported + 版本 + 白名单 capabilities（多余键被剥）", () => {
    const [p] = probeRuntimeEntrypoints(manifest([entry()]), deps());
    expect(p?.status).toBe("installed_unsupported");
    expect(p?.runtime).toBe("langgraph");
    expect(p?.version).toBe("0.1.0");
    expect(p?.models).toEqual(["a", "b"]);
    expect(p?.defaultModel).toBe("a");
    expect(p?.capabilities).toEqual({
      maxConcurrency: 1,
      persistentProcess: true,
      streamingText: true,
      usage: "tokens",
    });
    expect(p?.capabilities).not.toHaveProperty("bogus");
  });

  it("cwd 不存在 → misconfigured/cwd-not-found，不执行子进程", () => {
    const execute = vi.fn();
    const [p] = probeRuntimeEntrypoints(manifest([entry()]), deps({ cwdExists: () => false, execute }));
    expect(p?.status).toBe("misconfigured");
    expect(p?.errorCode).toBe("cwd-not-found");
    expect(execute).not.toHaveBeenCalled();
  });

  it("secretEnv 在 daemon env 缺失 → misconfigured/secret-env-missing", () => {
    const [p] = probeRuntimeEntrypoints(manifest([entry()]), deps({ env: {} }));
    expect(p?.status).toBe("misconfigured");
    expect(p?.errorCode).toBe("secret-env-missing");
  });

  it("command 不在 PATH → not_installed/command-not-found", () => {
    const [p] = probeRuntimeEntrypoints(manifest([entry()]), deps({ resolveCommand: () => null }));
    expect(p?.status).toBe("not_installed");
    expect(p?.errorCode).toBe("command-not-found");
  });

  it(".cmd/.bat 包装命令 → protocol_incompatible（必须直可执行文件）", () => {
    const [p] = probeRuntimeEntrypoints(manifest([entry()]), deps({ resolveCommand: () => "C:\\bin\\python.cmd" }));
    expect(p?.status).toBe("protocol_incompatible");
    expect(p?.errorCode).toBe("command-wrapper-unsupported");
  });

  it("execute 抛错 → misconfigured/probe-failed", () => {
    const [p] = probeRuntimeEntrypoints(
      manifest([entry()]),
      deps({
        execute: vi.fn(() => {
          throw new Error("spawn ENOENT");
        }),
      }),
    );
    expect(p?.status).toBe("misconfigured");
    expect(p?.errorCode).toBe("probe-failed");
  });

  it.each([
    ["多行输出", goodFrame + "\n" + goodFrame],
    ["非 JSON", "hello"],
    ["JSON 数组", "[]"],
    [
      "protocol 不符",
      JSON.stringify({
        protocol: "x",
        version: 1,
        type: "probe.result",
        runtime: { id: "langgraph" },
        capabilities: { maxConcurrency: 1 },
      }),
    ],
    [
      "version 不符",
      JSON.stringify({
        protocol: "slock.agent-runtime",
        version: 2,
        type: "probe.result",
        runtime: { id: "langgraph" },
        capabilities: { maxConcurrency: 1 },
      }),
    ],
    [
      "runtime.id 与 manifest 不符",
      JSON.stringify({
        protocol: "slock.agent-runtime",
        version: 1,
        type: "probe.result",
        runtime: { id: "langchain" },
        capabilities: { maxConcurrency: 1 },
      }),
    ],
    [
      "缺 capabilities",
      JSON.stringify({
        protocol: "slock.agent-runtime",
        version: 1,
        type: "probe.result",
        runtime: { id: "langgraph" },
      }),
    ],
  ])("probe 输出异常 %s → protocol_incompatible", (_l, stdout) => {
    const [p] = probeRuntimeEntrypoints(manifest([entry()]), deps({ execute: vi.fn(() => stdout) }));
    expect(p?.status).toBe("protocol_incompatible");
  });

  it("manifest 校验失败条目 → misconfigured 摘要（id/label/runtime/errorCode，不含命令/路径/secret）", () => {
    const probes = probeRuntimeEntrypoints(
      manifest([], [["bad-ep", { code: "entry-command-invalid", runtime: "langgraph", label: "Broken" }]]),
      deps(),
    );
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      id: "bad-ep",
      runtime: "langgraph",
      label: "Broken",
      status: "misconfigured",
      errorCode: "entry-command-invalid",
    });
    const serialized = JSON.stringify(probes);
    expect(serialized).not.toContain("/tmp/work");
    expect(serialized).not.toContain("python -m");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("sk-live");
  });

  it("secretEnv 声明的值按名注入子进程 env（值本身仍不进 probe 结果）", () => {
    const execute = vi.fn(() => goodFrame);
    probeRuntimeEntrypoints(manifest([entry()]), deps({ execute }));
    const childEnv = execute.mock.calls[0]?.[2]?.env as Record<string, string>;
    expect(childEnv.OPENAI_API_KEY).toBe("sk-live"); // 注入子进程
    expect(childEnv.PLAIN_FLAG).toBe("1");
    const [p] = probeRuntimeEntrypoints(manifest([entry()]), deps());
    expect(JSON.stringify(p)).not.toContain("sk-live"); // 但 probe 结果不外发
    expect(JSON.stringify(p)).not.toContain("PLAIN_FLAG");
  });

  it("P1.1 secretRefs：本机 store 缺值 → misconfigured/secret-ref-missing（不执行子进程）", () => {
    const execute = vi.fn();
    const [p] = probeRuntimeEntrypoints(
      manifest([entry({ secretRefs: ["STORED_KEY"] })]),
      deps({ resolveSecretRef: () => undefined, execute }),
    );
    expect(p?.status).toBe("misconfigured");
    expect(p?.errorCode).toBe("secret-ref-missing");
    expect(JSON.stringify(p)).not.toContain("STORED_KEY"); // 连变量名也不外发
    expect(execute).not.toHaveBeenCalled();
  });

  it("P1.1 secretRefs：store 有值 → 按名注入子进程 env，probe 结果不外发", () => {
    const execute = vi.fn(() => goodFrame);
    const [p] = probeRuntimeEntrypoints(
      manifest([entry({ secretRefs: ["STORED_KEY"] })]),
      deps({ resolveSecretRef: (_ep, name) => (name === "STORED_KEY" ? "stored-value" : undefined), execute }),
    );
    expect(p?.status).toBe("installed_unsupported");
    const childEnv = execute.mock.calls[0]?.[2]?.env as Record<string, string>;
    expect(childEnv.STORED_KEY).toBe("stored-value");
    expect(JSON.stringify(p)).not.toContain("stored-value");
    expect(JSON.stringify(p)).not.toContain("STORED_KEY");
  });

  it("execute 调用形态：args 追加 --slock-probe、cwd 用 manifest 值、超时封顶 15s", () => {
    const execute = vi.fn(() => goodFrame);
    probeRuntimeEntrypoints(manifest([entry({ startupTimeoutMs: 120_000 })]), deps({ execute }));
    expect(execute).toHaveBeenCalledWith(
      "/usr/bin/python",
      ["-m", "worker", "--slock-probe"],
      expect.objectContaining({ cwd: "/tmp/work", timeout: 15_000 }),
    );
  });
});
