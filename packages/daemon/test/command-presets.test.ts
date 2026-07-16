import { describe, it, expect } from "vitest";
import { COMMAND_PRESETS, getCommandPreset, renderResumeArgs } from "../src/command-presets.js";

describe("command-presets", () => {
  describe("COMMAND_PRESETS", () => {
    it("包含四种 CLI 预设", () => {
      expect(Object.keys(COMMAND_PRESETS).sort()).toEqual(["claude", "codex", "gemini", "opencode"]);
    });

    it("claude preset 使用 --dangerously-skip-permissions", () => {
      expect(COMMAND_PRESETS.claude?.yoloArgs).toContain("--dangerously-skip-permissions");
    });

    it("codex preset 使用 --dangerously-bypass-approvals-and-sandbox", () => {
      expect(COMMAND_PRESETS.codex?.yoloArgs).toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("gemini preset 使用 --yolo", () => {
      expect(COMMAND_PRESETS.gemini?.yoloArgs).toContain("--yolo");
    });

    it("opencode preset 没有 yolo args", () => {
      expect(COMMAND_PRESETS.opencode?.yoloArgs).toEqual([]);
    });
  });

  describe("getCommandPreset", () => {
    it("返回已注册 CLI 的 preset", () => {
      expect(getCommandPreset("claude").command).toBe("claude");
      expect(getCommandPreset("codex").command).toBe("codex");
    });

    it("未知 CLI 回退到 claude preset", () => {
      expect(getCommandPreset("nonexistent").command).toBe("claude");
    });
  });

  describe("renderResumeArgs", () => {
    it("替换 {session_id} 占位符", () => {
      const args = renderResumeArgs(COMMAND_PRESETS.claude!, "abc-123");
      expect(args).toEqual(["--resume", "abc-123"]);
    });

    it("无 resume 模板时返回空数组", () => {
      const fakePreset = { ...COMMAND_PRESETS.claude!, resumeArgsTemplate: null };
      expect(renderResumeArgs(fakePreset, "abc")).toEqual([]);
    });

    it("codex 使用 resume 子命令", () => {
      const args = renderResumeArgs(COMMAND_PRESETS.codex!, "xyz-789");
      expect(args).toEqual(["resume", "xyz-789"]);
    });

    it("opencode 使用 --session flag", () => {
      const args = renderResumeArgs(COMMAND_PRESETS.opencode!, "sess-1");
      expect(args).toEqual(["--session", "sess-1"]);
    });
  });
});