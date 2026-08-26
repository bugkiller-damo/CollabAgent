/**
 * Agent workspace 的 MCP 配置写入（headless + PTY 共用）。
 *
 * P0.7（2026-08-25）：从冻结的 agent-runtime-spawn.ts 迁出——headless 路径
 * （agent-runtime-dispatch.ts）也要用它，不该为一个非冻结函数 import 冻结文件。
 * 本文件不在 PTY 冻结范围，正常维护。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDaemonEnv } from "./config.js";

/**
 * 写入项目级 `.mcp.json`（Claude Code 在 cwd 里自动发现的 MCP server 配置，
 * 见 docs/2026-07-16/12-mcp-server-plan.md）+ `.claude/settings.local.json`
 * 里的 `enableAllProjectMcpServers: true`。
 *
 * 后者是为了跳过 Claude Code 首次遇到新 `.mcp.json` 时弹出的"是否信任这个
 * 项目的 MCP server"确认对话框——这类一次性信任对话框和 bug 1 的
 * Accept-Permissions 对话框是同一类风险：如果 bootstrap 消息在对话框还开着
 * 的时候被写入，会被对话框当输入吃掉，永久丢失。**这条路径还没做过真机
 * 验证**：如果之后实测发现仍然弹出信任对话框，需要在
 * agent-runtime-terms-dialog.ts 里加一个同类的检测 + 自动确认分支，而不是
 * 继续猜测配置项名称。
 */
export const writeMcpConfig = (
  workspace: string,
  agentId: string,
  agentTokenFile: string,
  serverUrl: string,
  mcpBundlePath: string,
): void => {
  // O11：.mcp.json 只放 token 文件路径（非敏感），不再内嵌明文 token；
  // MCP server 启动时按 SLOCK_AGENT_TOKEN_FILE 读文件取 token（见 mcp/slock-mcp-server.ts）
  const mcpConfig = {
    mcpServers: {
      slock: {
        command: "node",
        args: [mcpBundlePath],
        env: {
          SLOCK_AGENT_ID: agentId,
          SLOCK_AGENT_TOKEN_FILE: agentTokenFile,
          SLOCK_SERVER_URL: serverUrl,
        },
      },
    },
  };
  writeFileSync(join(workspace, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));

  const claudeDir = join(workspace, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // 坏 JSON（比如手工改坏了）——直接覆盖，不阻塞 MCP 信任配置生效
    }
  }
  settings.enableAllProjectMcpServers = true;
  // effort 降档：Claude Code 2.1.x 会话默认 high effort，thinking token 照付
  // （2026-07-29 实测：haiku agent 屏幕显示 "● high · /effort"，Thought for 22s）。
  // 协作平台的 agent 以执行类任务为主，medium 足够；SLOCK_AGENT_EFFORT 可覆盖。
  // 注意：settings.json 的 effort 键名未查到官方文档确认（2026-07-29 web 检索
  // 未证实）——Claude Code 对未知键静默忽略，写错无害；真机验证 /effort 指示
  // 没变的话说明键名不对，需要换控制通道（如 MAX_THINKING_TOKENS env）。
  const effort = loadDaemonEnv().agentEffort;
  if (settings.effort === undefined) {
    settings.effort = effort;
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
};
