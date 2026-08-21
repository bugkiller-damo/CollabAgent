/**
 * T8 经理分诊：决定 agent:deliver 是否附带 triageAgents。
 * 纯函数，便于 L1 单测（SQL 查询仍在 messages 路由里）。
 *
 * 触发面：非 DM + 顶层消息 + 无 agent 会被唤醒 + 频道开关开 + 有经理名。
 */
export function computeTriageAgents(input: {
  dm: boolean;
  threadId?: string | null;
  mentionAgents?: string[];
  enabled: boolean;
  managerName?: string | null;
}): string[] | undefined {
  const noAgentWoken = input.mentionAgents === undefined || input.mentionAgents.length === 0;
  if (input.dm) return undefined;
  if (input.threadId) return undefined;
  if (!noAgentWoken) return undefined;
  if (!input.enabled) return undefined;
  const name = input.managerName?.trim();
  if (!name) return undefined;
  return [name];
}
