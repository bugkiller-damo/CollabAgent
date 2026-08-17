import type { CommandPreset } from "./types/index.js";

/**
 * O12：claude 主路径权限收敛——从「--dangerously-skip-permissions 全放行」改为
 * 显式工具白名单。白名单内的工具免确认执行；未列出的工具（WebFetch/WebSearch/
 * Notebook 系/Task 等）在 PTY 里会弹权限确认框，无人应答 → 回合超时回收，
 * 即 fail-closed。MCP slock 工具的放行由 .claude/settings.local.json 的
 * enableAllProjectMcpServers 承担，与本白名单正交。
 *
 * 默认集合 = 协作开发最小工具面（对照 buzz-dev-mcp 只暴露 shell+文件编辑）：
 * Bash 任意命令（agent 要跑构建/测试/git，收不了）+ 文件读写检索 + 待办。
 * 运维可用 SLOCK_AGENT_ALLOWED_TOOLS 覆盖（逗号/空格分隔，claude CLI 两种都收）。
 */
export const DEFAULT_AGENT_ALLOWED_TOOLS = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite";

/** 每次调用读一次 env（测试可在 beforeEach 直接改 process.env 生效） */
export function getClaudePermissionArgs(): string[] {
  const tools = (process.env.SLOCK_AGENT_ALLOWED_TOOLS || DEFAULT_AGENT_ALLOWED_TOOLS).trim();
  return [`--allowedTools=${tools}`];
}

/**
 * 各 CLI 的参数预设表。
 *
 * 每种 agent CLI 都有自己独特的命令行约定：
 * - claude: 已收敛为 --allowedTools 白名单（O12，见 getClaudePermissionArgs）/ --resume
 * - codex: --dangerously-bypass-approvals-and-sandbox / resume
 * - gemini: --yolo / --resume
 * - opencode: 无 yolo（默认放开） / --session
 */
export const COMMAND_PRESETS: Record<string, CommandPreset> = {
  claude: {
    command: "claude",
    // 静态默认（不含 env 覆盖）；真实 spawn 路径走 getClaudePermissionArgs() 动态求值
    yoloArgs: [`--allowedTools=${DEFAULT_AGENT_ALLOWED_TOOLS}`],
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
