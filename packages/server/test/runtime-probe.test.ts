import { describe, expect, it } from "vitest";
import {
  normalizeEntrypoints,
  normalizeInterrupts,
  normalizeRuntimes,
  runtimeChipLabels,
} from "../src/lib/runtime-probe.js";

describe("normalizeRuntimes", () => {
  it("旧 string[] 当成 installed", () => {
    expect(normalizeRuntimes(["node:20", "claude"])).toEqual([
      { id: "node:20", status: "installed" },
      { id: "claude", status: "installed" },
    ]);
  });

  it("结构化对象保留 status / version", () => {
    expect(
      normalizeRuntimes([
        { id: "claude", status: "installed", version: "1.2" },
        { id: "codex", status: "not_installed" },
        { id: "gemini", status: "installed_unsupported", version: "0.1" },
        { bogus: true },
        "legacy",
      ]),
    ).toEqual([
      { id: "claude", status: "installed", version: "1.2" },
      { id: "codex", status: "not_installed" },
      { id: "gemini", status: "installed_unsupported", version: "0.1" },
      { id: "legacy", status: "installed" },
    ]);
  });

  it("chip 文案", () => {
    expect(
      runtimeChipLabels([
        { id: "claude", status: "installed", version: "1.0" },
        { id: "codex", status: "installed_unsupported" },
        { id: "gemini", status: "not_installed" },
      ]),
    ).toEqual(["claude 1.0", "codex（未接线）", "gemini（未装）"]);
  });
});

// Phase 4：ready.entrypoints 归一化——五态全集 + 安全面过滤（command/cwd/env 不外泄）
describe("normalizeEntrypoints", () => {
  it("非数组 / 非法条目 → []", () => {
    expect(normalizeEntrypoints(undefined)).toEqual([]);
    expect(normalizeEntrypoints("x")).toEqual([]);
    expect(normalizeEntrypoints([null, "str", 42, [], { noId: true }])).toEqual([]);
  });

  it("全字段保留：id/label/runtime/status/models/mode/capabilities/error", () => {
    expect(
      normalizeEntrypoints([
        {
          id: "lg-1",
          label: "LangGraph Agent",
          runtime: "langgraph",
          status: "installed_unsupported",
          version: "0.1.0",
          modelMode: "select",
          models: ["openai:gpt-5-mini", "anthropic:claude-sonnet-4-5"],
          defaultModel: "openai:gpt-5-mini",
          capabilities: { durableThreads: true, interrupts: true },
        },
      ]),
    ).toEqual([
      {
        id: "lg-1",
        label: "LangGraph Agent",
        runtime: "langgraph",
        status: "installed_unsupported",
        version: "0.1.0",
        modelMode: "select",
        models: ["openai:gpt-5-mini", "anthropic:claude-sonnet-4-5"],
        defaultModel: "openai:gpt-5-mini",
        capabilities: { durableThreads: true, interrupts: true },
      },
    ]);
  });

  it("五个 entrypoint 状态全收（含 misconfigured / protocol_incompatible）", () => {
    const out = normalizeEntrypoints([
      { id: "a", status: "installed" },
      { id: "b", status: "not_installed" },
      { id: "c", status: "installed_unsupported" },
      { id: "d", status: "misconfigured" },
      { id: "e", status: "protocol_incompatible" },
    ]);
    expect(out.map((e) => e.status)).toEqual([
      "installed",
      "not_installed",
      "installed_unsupported",
      "misconfigured",
      "protocol_incompatible",
    ]);
  });

  it("未知 status → misconfigured；未知 modelMode → fixed", () => {
    const [e] = normalizeEntrypoints([{ id: "x", status: "weird", modelMode: "weird" }]);
    expect(e.status).toBe("misconfigured");
    expect(e.modelMode).toBe("fixed");
  });

  it("敏感字段不外泄：command/cwd/env/secretEnv 被剥离", () => {
    const [e] = normalizeEntrypoints([
      {
        id: "sec",
        label: "S",
        status: "installed",
        modelMode: "fixed",
        command: "python",
        cwd: "/abs/path",
        env: { KEY: "v" },
        secretEnv: ["OPENAI_API_KEY"],
      },
    ]);
    expect(e).toEqual({ id: "sec", label: "S", status: "installed", modelMode: "fixed" });
    expect(JSON.stringify(e)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(e)).not.toContain("/abs/path");
  });

  it("label 缺省回落 id；models 过滤空串", () => {
    const [e] = normalizeEntrypoints([{ id: "bare", status: "installed", models: ["ok", "", 3, "  "] }]);
    expect(e.label).toBe("bare");
    expect(e.models).toEqual(["ok"]);
  });

  it("批次 C（P1.5）：diagnostics 白名单透传（lastError{code,message,at}/lastOkAt）", () => {
    const [e] = normalizeEntrypoints([
      {
        id: "ep-1",
        status: "installed_unsupported",
        diagnostics: {
          lastError: { code: "runtime-start-timeout", message: "worker t/o", at: "2026-09-22T00:00:00.000Z" },
          lastOkAt: "2026-09-21T00:00:00.000Z",
        },
      },
    ]);
    expect(e.diagnostics).toEqual({
      lastError: { code: "runtime-start-timeout", message: "worker t/o", at: "2026-09-22T00:00:00.000Z" },
      lastOkAt: "2026-09-21T00:00:00.000Z",
    });
  });

  it("批次 C（P1.5）：diagnostics 剥离非白名单字段（防误带 command/env/secret）", () => {
    const [e] = normalizeEntrypoints([
      {
        id: "ep-1",
        status: "installed_unsupported",
        diagnostics: {
          lastError: {
            code: "x",
            message: "m",
            at: "t",
            command: "python -m worker", // 非白名单字段——剥掉
            stderr: "raw tail",
          },
          lastOkAt: "ok-t",
          env: { KEY: "v" },
          cwd: "/abs/path",
        },
      },
    ]);
    expect(e.diagnostics?.lastError).toEqual({ code: "x", message: "m", at: "t" });
    expect(JSON.stringify(e.diagnostics)).not.toContain("python -m worker");
    expect(JSON.stringify(e.diagnostics)).not.toContain("/abs/path");
    expect(JSON.stringify(e.diagnostics)).not.toContain("raw tail");
  });

  it("批次 C（P1.5）：diagnostics 畸形（缺 message/at / 非对象）→ 不携带该字段", () => {
    const [a] = normalizeEntrypoints([
      { id: "a", status: "installed", diagnostics: { lastError: { message: "m" } } }, // 缺 at
    ]);
    expect(a.diagnostics).toBeUndefined();
    const [b] = normalizeEntrypoints([{ id: "b", status: "installed", diagnostics: "broken" }]);
    expect(b.diagnostics).toBeUndefined();
    const [c] = normalizeEntrypoints([
      { id: "c", status: "installed", diagnostics: { lastError: { message: "x".repeat(1000), at: "t" } } },
    ]);
    expect(c.diagnostics?.lastError?.message.length).toBe(600); // 再截断兜底
  });
});

// 批次 C（P1.4）：interrupts:state 摘要归一化——resumeToken/本地字段不出 server 边界
describe("normalizeInterrupts", () => {
  const base = {
    agentId: "a1",
    conversationId: "slock:v1:a1:channel:general",
    interruptId: "i1",
    prompt: "批准部署？",
    createdAt: 1000,
    expiresAt: 2000,
  };

  it("合法摘要全字段保留（含 agentName/runtime/channel/threadId）", () => {
    expect(
      normalizeInterrupts([
        { ...base, agentName: "researcher", runtime: "langgraph", channel: "general", threadId: "th-1" },
      ]),
    ).toEqual([{ ...base, agentName: "researcher", runtime: "langgraph", channel: "general", threadId: "th-1" }]);
  });

  it("resumeToken / 协议外字段被剥离（纵深防御：契约不该含，万一误发也剥）", () => {
    const [i] = normalizeInterrupts([{ ...base, resumeToken: "SECRET-TOKEN", command: "python", cwd: "/x" }]);
    expect(i).toEqual(base);
    expect(JSON.stringify(i)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(i)).not.toContain("python");
  });

  it("必填字段缺失/错型 → 该条丢弃（半帧不进审批面）", () => {
    expect(
      normalizeInterrupts([
        base,
        { ...base, conversationId: "" }, // 缺 conversationId
        { ...base, interruptId: 7 }, // 错型
        { ...base, expiresAt: "soon" }, // 错型
        "junk",
        null,
      ]),
    ).toEqual([base]);
  });

  it("非数组 → []", () => {
    expect(normalizeInterrupts(undefined)).toEqual([]);
    expect(normalizeInterrupts("x")).toEqual([]);
    expect(normalizeInterrupts({ interrupts: [] })).toEqual([]);
  });
});
