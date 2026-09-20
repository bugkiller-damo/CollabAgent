import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyAgentDirName, safeAgentDirName } from "./agent-dir-name.js";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";
import { generateRelaySystemPrompt, generateSystemPrompt } from "./system-prompt.js";

/**
 * Agent 启动指令与工作区管理模块。
 *
 * 职责：
 * - 生成系统提示文件（writeAgentPrompt → writeSystemPromptFile）
 * - 创建工作区目录（agentWorkspace → createWorkspaceDir）
 */

export interface DispatchContext {
  /** 这个 agent 是不是当前频道的经理（channel_members.is_manager） */
  isManager: boolean;
  /** 频道里除自己之外的其它 agent handle（供经理挑选派发对象） */
  otherAgents: string[];
}

/**
 * 查询"我是不是这个频道的经理、频道里还有哪些别的 agent"，用来在系统提示里
 * 写成确定的事实，而不是让 agent 自己猜——之前的通用条件句式（"如果你是经理…"）
 * agent 没有任何办法判断自己是不是经理，实测会直接把整条指令当模糊闲聊处理。
 * 查询失败（网络问题/频道还没同步等）时返回 null，调用方应退回通用提示文案。
 */
export async function fetchDispatchContext(
  serverUrl: string,
  apiKey: string,
  agentId: string,
  channelName: string,
): Promise<DispatchContext | null> {
  try {
    const url = new URL(`/internal/agent/${agentId}/channel-members`, serverUrl);
    url.searchParams.set("channel", "#" + channelName);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      members: { member_id: string; member_type: string; is_manager?: boolean; handle: string }[];
    };
    const members = data.members || [];
    const self = members.find((m) => m.member_type === "agent" && String(m.member_id) === String(agentId));
    const otherAgents = members
      .filter((m) => m.member_type === "agent" && String(m.member_id) !== String(agentId))
      .map((m) => m.handle);
    return { isManager: !!self?.is_manager, otherAgents };
  } catch {
    return null;
  }
}

/**
 * A1.3：每回合任务语境行——「你在本频道的角色 / 可派发名单」。
 * 系统提示只在 spawn 时读一次且首频道语境会漂（见报告 8.5），角色事实必须随
 * 回合 prompt 走；dispatchContext 为 null（查询失败 / DM）时调用方不追加本行。
 */
export function buildRoleContextLine(channelName: string, ctx: DispatchContext): string {
  const role = ctx.isManager
    ? `经理（可用 \`dispatch_task\` 派发任务${
        ctx.otherAgents.length
          ? `；本频道可派发：${ctx.otherAgents.map((a) => "@" + a).join("、")}`
          : "；本频道暂无其它 agent"
      }）`
    : "普通成员（不是经理，不能调用 dispatch_task/cancel_dispatch）";
  return `【本回合语境】你在 #${channelName} 的角色：${role}。`;
}

/**
 * 生成系统提示文件并返回文件路径。
 * A3 起去频道化：系统提示不含 channelName/「本次任务」——频道与角色事实走
 * 每回合的【本回合语境】行（buildRoleContextLine），避免 spawn 首频道语境
 * 漂移（报告 §8.5）。
 */
export function writeSystemPromptFile(
  agentName: string,
  autonomous: boolean,
  info: { displayName?: string; description?: string },
  dispatchContext?: DispatchContext | null,
): string {
  const identity = { name: agentName, displayName: info.displayName, description: info.description };
  const prompt = autonomous ? generateSystemPrompt(identity, dispatchContext) : generateRelaySystemPrompt(identity);
  const dir = slockDir();
  mkdirPrivateSync(dir);
  const file = join(dir, `sysprompt-${safeAgentDirName(agentName)}.md`);
  writeFileSync(file, prompt, "utf-8");
  return file;
}

/** `.slock` 状态树下该 agent 的工作区根目录（与 spawn cwd 一致；H6 起经 slockDir 解析） */
export function agentWorkspacePath(agentName: string): string {
  return join(slockDir(), "workspaces", safeAgentDirName(agentName));
}

/** 创建 agent 工作区目录，不存在时种入 MEMORY.md 模板 */
export function createWorkspaceDir(agentName: string, info: { displayName?: string; description?: string }): string {
  const dir = agentWorkspacePath(agentName);
  mkdirPrivateSync(dir);
  const memFile = join(dir, "MEMORY.md");
  if (!existsSync(memFile)) {
    // 迁移旧命名方案的工作区：旧方案把非 ASCII 全替换成 "_"（等长中文名共用
    // 同一个目录，见 agent-dir-name.ts）。新目录还没有 MEMORY.md 且旧目录有，
    // 就把旧记忆复制过来——数据本来就是混的，复制不会让情况变更糟。
    const legacyDir = join(slockDir(), "workspaces", legacyAgentDirName(agentName));
    const legacyMem = join(legacyDir, "MEMORY.md");
    if (legacyDir !== dir && existsSync(legacyMem)) {
      try {
        copyFileSync(legacyMem, memFile);
        console.log(
          `[Runtime] Migrated MEMORY.md from legacy workspace ${legacyAgentDirName(agentName)} -> ${safeAgentDirName(agentName)}`,
        );
      } catch {
        /* 迁移失败退回种模板，不阻塞启动 */
      }
    }
  }
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
      `## 交付物`,
      `（交付给用户的产出物放 deliverables/<日期>-<主题>/，记录附件 id 与内容摘要）`,
      ``,
    ].join("\n");
    writeFileSync(memFile, seed, "utf-8");
  }
  // A7.2：交付目录约定——代码/多文件/长报告写这里，再经 upload_attachment 发出；
  // web workspace:read 白名单已放开本目录（agent-workspace.ts），用户可直接浏览。
  mkdirPrivateSync(join(dir, "deliverables"));
  return dir;
}
