import type { HandlerContext } from "./types.js";

export async function handleReminderFire(ctx: HandlerContext, msg: Record<string, unknown>): Promise<void> {
  const remAgentId = msg.agentId as string;
  const reminder = (msg.reminder as any) || {};
  // 注册表以 name 为键,入信只有 agentId(UUID)——先反查注册名
  // （此前直接用 UUID 查 hasAgent 必 false,agent 提醒静默丢弃,2026-08-19 E2E 实锤）
  const remName = ctx.runtime.resolveAgentName(remAgentId);
  if (!remName) {
    console.log("[Daemon] reminder.fire for unknown agent", remAgentId);
    return;
  }
  console.log(`[Daemon] reminder fired for @${remName}: ${reminder.title} (${reminder.kind || "reminder"})`);
  await ctx.runtime.runAgentReminder(remName, reminder);
}
