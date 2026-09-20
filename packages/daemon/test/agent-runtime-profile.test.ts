import { describe, expect, it } from "vitest";
import type { RuntimeManifestEntry, RuntimeManifestSnapshot } from "../src/agent-runtime-manifest.js";
import {
  assertResolvedAgentRuntimeProfile,
  parseAgentRuntimeProfile,
  resolveAgentRuntimeProfile,
} from "../src/agent-runtime-profile.js";
import { DispatchError, isRetriableError } from "../src/errors.js";

/**
 * Phase 1：agent runtime profile 的解析契约。
 * runtime = 显式值 ?? "claude"；claude 拒收 entrypoint；langchain/langgraph
 * 必须有 manifest 内匹配的 entrypoint；model 受 manifest fixed/allowlist 约束。
 * identity 随 runtime/model/entrypoint/manifest 修订变化——dispatch 据此失效会话。
 */

const entry = (over: Partial<RuntimeManifestEntry> = {}): RuntimeManifestEntry => ({
  id: "ep-1",
  runtime: "langgraph",
  label: "Graph",
  command: "python",
  args: [],
  cwd: "/tmp/w",
  env: {},
  secretEnv: [],
  model: { mode: "fixed", default: "gpt-4o", allowed: [] },
  requireDurableThreads: false,
  startupTimeoutMs: 15_000,
  silenceTimeoutMs: 300_000,
  shutdownTimeoutMs: 10_000,
  revision: "rev-a",
  ...over,
});

const manifest = (...entries: RuntimeManifestEntry[]): RuntimeManifestSnapshot => ({
  path: "<test>",
  revision: "snap-rev",
  entries: new Map(entries.map((e) => [e.id, e])),
  invalidEntries: new Map(),
});

const INVALID_MANIFEST: RuntimeManifestSnapshot = {
  path: "<test>",
  revision: "bad",
  entries: new Map(),
  invalidEntries: new Map(),
  fatalError: "manifest-invalid",
};

const expectError = (
  info: Parameters<typeof resolveAgentRuntimeProfile>[0],
  snap: RuntimeManifestSnapshot,
  code: string,
) => {
  const p = resolveAgentRuntimeProfile(info, snap);
  expect(p.error?.code).toBe(code);
  expect(() => assertResolvedAgentRuntimeProfile(p)).toThrow(DispatchError);
  try {
    assertResolvedAgentRuntimeProfile(p);
    expect.unreachable();
  } catch (err) {
    expect(isRetriableError(err)).toBe(false); // 全部 permanent——profile 错不重试
  }
};

describe("resolveAgentRuntimeProfile", () => {
  it("无 runtime 字段 → claude（legacy 兼容），identity 稳定", () => {
    const p = resolveAgentRuntimeProfile({}, manifest());
    expect(p.runtime).toBe("claude");
    expect(p.error).toBeUndefined();
    expect(p.identity).toBe(resolveAgentRuntimeProfile({}, manifest()).identity);
  });

  it("runtime 大小写/空白归一；显式 claude 与缺省同 identity", () => {
    const a = resolveAgentRuntimeProfile({ runtime: " Claude " }, manifest());
    expect(a.runtime).toBe("claude");
    expect(a.identity).toBe(resolveAgentRuntimeProfile({}, manifest()).identity);
  });

  it("claude + entrypoint → entrypoint-not-allowed", () => {
    expectError({ runtime: "claude", entrypoint: "ep-1" }, manifest(), "entrypoint-not-allowed");
  });

  it("上游冲突 → runtime-profile-conflict 直通", () => {
    expectError(
      { runtimeProfileError: { code: "runtime-profile-conflict", message: "conflict" } },
      manifest(),
      "runtime-profile-conflict",
    );
  });

  it("langgraph 无 entrypoint → entrypoint-required", () => {
    expectError({ runtime: "langgraph" }, manifest(), "entrypoint-required");
  });

  it("entrypoint 不在 manifest → entrypoint-not-found", () => {
    expectError({ runtime: "langgraph", entrypoint: "ghost" }, manifest(entry()), "entrypoint-not-found");
  });

  it("entrypoint 的 runtime 与所选不符 → entrypoint-runtime-mismatch", () => {
    expectError(
      { runtime: "langchain", entrypoint: "ep-1" },
      manifest(entry({ runtime: "langgraph" })),
      "entrypoint-runtime-mismatch",
    );
  });

  it("manifest fatal → manifest-invalid；invalidEntries 命中同码", () => {
    expectError({ runtime: "langgraph", entrypoint: "ep-1" }, INVALID_MANIFEST, "manifest-invalid");
    const snap = manifest();
    (snap.invalidEntries as Map<string, { code: string }>).set("ep-1", { code: "entry-command-invalid" });
    expectError({ runtime: "langgraph", entrypoint: "ep-1" }, snap, "manifest-invalid");
  });

  it("model mode=fixed：请求 ≠ default → model-not-allowed；相等 → 通过", () => {
    const snap = manifest(entry());
    expectError({ runtime: "langgraph", entrypoint: "ep-1", model: "other" }, snap, "model-not-allowed");
    const ok = resolveAgentRuntimeProfile({ runtime: "langgraph", entrypoint: "ep-1", model: "gpt-4o" }, snap);
    expect(ok.error).toBeUndefined();
    expect(ok.model).toBe("gpt-4o");
  });

  it("model mode=select：缺省取 default；非 allowlist → model-not-allowed", () => {
    const snap = manifest(entry({ model: { mode: "select", default: "a", allowed: ["a", "b"] } }));
    expect(resolveAgentRuntimeProfile({ runtime: "langgraph", entrypoint: "ep-1" }, snap).model).toBe("a");
    expect(resolveAgentRuntimeProfile({ runtime: "langgraph", entrypoint: "ep-1", model: "b" }, snap).model).toBe("b");
    expectError({ runtime: "langgraph", entrypoint: "ep-1", model: "c" }, snap, "model-not-allowed");
  });

  it("server 不能绕过 fixed model 约束（manifest 是本机唯一权威）", () => {
    expectError(
      { runtime: "langgraph", entrypoint: "ep-1", model: "attacker-model" },
      manifest(entry()),
      "model-not-allowed",
    );
  });

  it("未知非 bridge runtime（codex 等）不产 profile 错误——留给 registry 判 runtime-unsupported", () => {
    const p = resolveAgentRuntimeProfile({ runtime: "codex" }, manifest());
    expect(p.runtime).toBe("codex");
    expect(p.error).toBeUndefined();
  });

  it("identity 随 runtime/model/entrypoint/manifest 修订变化", () => {
    const base = resolveAgentRuntimeProfile({ runtime: "langgraph", entrypoint: "ep-1" }, manifest(entry()));
    const byModel = resolveAgentRuntimeProfile(
      { runtime: "langgraph", entrypoint: "ep-1", model: "gpt-4o" },
      manifest(entry()),
    );
    // fixed 模式 requestedModel===default → 解析后 model 相同 → identity 相同
    expect(byModel.identity).toBe(base.identity);
    const byRevision = resolveAgentRuntimeProfile(
      { runtime: "langgraph", entrypoint: "ep-1" },
      manifest(entry({ revision: "rev-b" })),
    );
    expect(byRevision.identity).not.toBe(base.identity); // manifest 修订 → 换身份
    const byRuntime = resolveAgentRuntimeProfile(
      { runtime: "langchain", entrypoint: "ep-1" },
      manifest(entry({ runtime: "langchain" })),
    );
    expect(byRuntime.identity).not.toBe(base.identity);
    const byEntrypoint = resolveAgentRuntimeProfile(
      { runtime: "langgraph", entrypoint: "ep-2" },
      manifest(entry({ id: "ep-2" })),
    );
    expect(byEntrypoint.identity).not.toBe(base.identity);
    // claude：model 变化 → 换身份（registerAgent 据此失效旧会话）
    expect(resolveAgentRuntimeProfile({ model: "haiku" }, manifest()).identity).not.toBe(
      resolveAgentRuntimeProfile({}, manifest()).identity,
    );
  });
});

describe("parseAgentRuntimeProfile", () => {
  it("对象/JSON 字符串/垃圾输入", () => {
    expect(parseAgentRuntimeProfile({ runtime: "claude", model: "sonnet" })).toEqual({
      runtime: "claude",
      model: "sonnet",
      entrypoint: undefined,
    });
    expect(parseAgentRuntimeProfile('{"runtime":"langgraph","entrypoint":"ep-1"}')).toEqual({
      runtime: "langgraph",
      model: undefined,
      entrypoint: "ep-1",
    });
    expect(parseAgentRuntimeProfile("not json")).toEqual({});
    expect(parseAgentRuntimeProfile(null)).toEqual({});
    expect(parseAgentRuntimeProfile([1])).toEqual({});
    expect(parseAgentRuntimeProfile({ runtime: 42 })).toEqual({
      runtime: undefined,
      model: undefined,
      entrypoint: undefined,
    });
  });
});
