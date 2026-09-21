import { describe, expect, it } from "vitest";
import { normalizeEntrypoints, normalizeRuntimes, runtimeChipLabels } from "../src/lib/runtime-probe.js";

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
});
