import { describe, expect, it } from "vitest";
import {
  COMMAND_PRESETS,
  DEFAULT_AGENT_ALLOWED_TOOLS,
  getClaudePermissionArgs,
  getCommandPreset,
  renderResumeArgs,
} from "../src/command-presets.js";

describe("command-presets", () => {
  describe("COMMAND_PRESETS", () => {
    it("包含四种 CLI 预设", () => {
      expect(Object.keys(COMMAND_PRESETS).sort()).toEqual(["claude", "codex", "gemini", "opencode"]);
    });

    it("claude preset 已收敛为 --allowedTools 白名单（O12），无 --dangerously-skip-permissions", () => {
      const args = COMMAND_PRESETS.claude!.yoloArgs;
      expect(args.some((a) => a.startsWith("--allowedTools="))).toBe(true);
      expect(args.join(" ")).not.toContain("--dangerously-skip-permissions");
      expect(args.join(" ")).not.toContain("bypassPermissions");
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

  describe("getClaudePermissionArgs（O12）", () => {
    it("默认输出 --allowedTools 白名单，含最小工具面且不含危险旗标", () => {
      delete process.env.SLOCK_AGENT_ALLOWED_TOOLS;
      const args = getClaudePermissionArgs();
      expect(args).toEqual([`--allowedTools=${DEFAULT_AGENT_ALLOWED_TOOLS}`]);
      const joined = args.join(" ");
      for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "mcp__slock"]) {
        expect(joined).toContain(tool);
      }
      expect(joined).not.toContain("--dangerously-skip-permissions");
    });

    it("SLOCK_AGENT_ALLOWED_TOOLS 覆盖默认集合", () => {
      process.env.SLOCK_AGENT_ALLOWED_TOOLS = "Bash,Read";
      try {
        expect(getClaudePermissionArgs()).toEqual(["--allowedTools=Bash,Read"]);
      } finally {
        delete process.env.SLOCK_AGENT_ALLOWED_TOOLS;
      }
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
