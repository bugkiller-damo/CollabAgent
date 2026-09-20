import type { WsToDaemonMessage } from "@collabagent/shared";
import type { ReminderFirePayload } from "../agent-runtime-dispatch.js";
import type { HandlerContext } from "./types.js";

type ReminderMsg = Extract<WsToDaemonMessage, { type: "reminder.fire" }>;

export async function handleReminderFire(ctx: HandlerContext, msg: ReminderMsg): Promise<void> {
  const remAgentId = msg.agentId;
  const reminder = msg.reminder;
  // 注册表以 name 为键,入信只有 agentId(UUID)——先反查注册名
  // （此前直接用 UUID 查 hasAgent 必 false,agent 提醒静默丢弃,2026-08-19 E2E 实锤）
  const remName = ctx.runtime.resolveAgentName(remAgentId);
  if (!remName) {
    console.log("[Daemon] reminder.fire for unknown agent", remAgentId);
    return;
  }
  console.log(`[Daemon] reminder fired for @${remName}: ${reminder.title} (${reminder.kind || "reminder"})`);
  const payload: ReminderFirePayload = { title: reminder.title, kind: reminder.kind };
  // Phase 2：reminder.id 是 conversationId 的 reminder 分桶键——WS schema
  // 缺省 ""，空串不落 payload（否则下游拿到畸形 sourceId）
  if (reminder.id) payload.id = reminder.id;
  if (reminder.channel) payload.channel = reminder.channel;
  if (reminder.instructions) payload.instructions = reminder.instructions;
  await ctx.runtime.runAgentReminder(remName, payload);
}
