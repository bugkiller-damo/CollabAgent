import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateRelaySystemPrompt, generateSystemPrompt } from "./system-prompt.js";
import type { AgentInfo } from "./types/index.js";

/**
 * Agent 启动指令与工作区管理模块。
 *
 * 职责：
 * - 生成系统提示文件（writeAgentPrompt → writeSystemPromptFile）
 * - 创建工作区目录（agentWorkspace → createWorkspaceDir）
 */

/** 生成系统提示文件并返回文件路径 */
export function writeSystemPromptFile(
  agentName: string,
  channelName: string,
  autonomous: boolean,
  info: { displayName?: string; description?: string },
): string {
  const identity = { name: agentName, displayName: info.displayName, description: info.description };
  const prompt = autonomous
    ? generateSystemPrompt(identity, channelName)
    : generateRelaySystemPrompt(identity, channelName);
  const dir = join(process.cwd(), ".slock");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `sysprompt-${agentName.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`);
  writeFileSync(file, prompt, "utf-8");
  return file;
}

/** 创建 agent 工作区目录，不存在时种入 MEMORY.md 模板 */
export function createWorkspaceDir(
  agentName: string,
  info: { displayName?: string; description?: string },
): string {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = join(process.cwd(), ".slock", "workspaces", safe);
  mkdirSync(dir, { recursive: true });
  const memFile = join(dir, "MEMORY.md");
  if (!existsSync(memFile)) {
    const seed = [
      `# ${info.displayName || agentName} 的记忆`,
      ``,
      `## 角色`,
      info.description?.trim() || `@${agentName}，CollabAgent 平台上的 AI Agent。`,
      ``,
      `## 关于用户 / 团队`,
      `（在这里记录长期有用的信息：人的偏好、称呼、约定等）`,
      ``,
      `## 频道与长期任务`,
      `（各频道在聊什么、有哪些进行中的长期事项）`,
      ``,
      `## 近期上下文`,
      `（最近发生了什么、聊到哪了）`,
      ``,
    ].join("\n");
    writeFileSync(memFile, seed, "utf-8");
  }
  return dir;
}

/**
 * 构建 Agent 启动指令（供分发时使用）。
 * 包含身份标记、角色说明和协议文档。
 */
export function buildStartupInstructions(agent: AgentInfo, workspaceDir: string): string {
  return [
    `# Agent: ${agent.agentName}`,
    `ID: ${agent.agentId}`,
    workspaceDir ? `Workspace: ${workspaceDir}` : "",
    `Role: ${agent.displayName || agent.agentName}`,
    agent.description ? `Description: ${agent.description}` : "",
    "",
    "## Protocol",
    "- Use \`slock\` CLI to interact with the platform",
    "- Messages are dispatched via stdin in stream-json format",
    "- Respond only when work is complete",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 生成身份标记行 */
export function buildIdentityMarker(agent: AgentInfo): string {
  return `[Agent ${agent.agentName} (${agent.agentId.slice(0, 8)})]`;
}

/** 生成协议说明文档 */
export function buildProtocolDoc(role: string): string {
  return [
    `## ${role} 协议`,
    "",
    "1. 使用 slock CLI 与平台交互",
    "2. 每条消息是一个回合，完成后等待下一条",
    "3. 用 MEMORY.md 记录长期信息",
  ].join("\n");
}

/** 生成提醒尾部内容 */
export function buildReminderTail(role: string, dispatchId?: string): string {
  const tail = [`⏰ ${role} 提醒`];
  if (dispatchId) tail.push(`Dispatch: ${dispatchId}`);
  return tail.join(" | ");
}
