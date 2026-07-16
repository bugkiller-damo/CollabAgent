import type { CommandPreset } from "./types/index.js";

/**
 * 各 CLI 的参数预设表。
 *
 * 每种 agent CLI 都有自己独特的命令行约定：
 * - claude: --dangerously-skip-permissions / --resume
 * - codex: --dangerously-bypass-approvals-and-sandbox / resume
 * - gemini: --yolo / --resume
 * - opencode: 无 yolo（默认放开） / --session
 */
export const COMMAND_PRESETS: Record<string, CommandPreset> = {
  claude: {
    command: "claude",
    yoloArgs: ["--dangerously-skip-permissions"],
    resumeArgsTemplate: "--resume {session_id}",
    sessionIdCapture: { source: "claude_project_jsonl_dir" },
  },
  codex: {
    command: "codex",
    yoloArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    resumeArgsTemplate: "resume {session_id}",
    sessionIdCapture: null,
  },
  gemini: {
    command: "gemini",
    yoloArgs: ["--yolo"],
    resumeArgsTemplate: "--resume {session_id}",
    sessionIdCapture: null,
  },
  opencode: {
    command: "opencode",
    yoloArgs: [],
    resumeArgsTemplate: "--session {session_id}",
    sessionIdCapture: null,
  },
};

/** 查找预设；未注册 CLI 走 'claude' 作为兜底 */
export function getCommandPreset(name: string): CommandPreset {
  const preset = COMMAND_PRESETS[name];
  if (!preset) {
    console.warn(`[Presets] Unknown CLI '${name}', falling back to 'claude' preset`);
    return COMMAND_PRESETS.claude!;
  }
  return preset;
}

/** 渲染 resume 参数（替换 {session_id} 占位符） */
export function renderResumeArgs(preset: CommandPreset, sessionId: string): string[] {
  if (!preset.resumeArgsTemplate) return [];
  const rendered = preset.resumeArgsTemplate.replace("{session_id}", sessionId);
  return rendered.split(/\s+/).filter(Boolean);
}