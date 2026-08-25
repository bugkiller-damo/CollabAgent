import { describe, expect, it } from "vitest";
import { normalizeRuntimes, runtimeChipLabels } from "../src/lib/runtime-probe.js";

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
