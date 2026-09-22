import type { WsToDaemonMessage } from "@collabagent/shared";
import { handleAgentDuty, handleAgentStart, handleAgentStop } from "./agent.js";
import { handleAgentDeliver } from "./deliver.js";
import { handlePing } from "./ping.js";
import { handleReminderFire } from "./reminder.js";
import { handleTerminalHistory, handleTerminalResize, handleTerminalUnwatch, handleTerminalWatch } from "./terminal.js";
import type { HandlerContext } from "./types.js";
import { handleWorkspaceRead } from "./workspace.js";

export { parseWsToDaemonMessage } from "./inbound.js";
export type { HandlerContext } from "./types.js";

export async function dispatchDaemonMessage(ctx: HandlerContext, msg: WsToDaemonMessage): Promise<void> {
  switch (msg.type) {
    case "agent:start":
      handleAgentStart(ctx, msg);
      break;
    case "agent:deliver":
      await handleAgentDeliver(ctx, msg);
      break;
    case "agent:stop":
      handleAgentStop(ctx, msg);
      break;
    case "agent:duty":
      handleAgentDuty(ctx, msg);
      break;
    case "reminder.fire":
      await handleReminderFire(ctx, msg);
      break;
    case "terminal:watch":
      handleTerminalWatch(ctx, msg);
      break;
    case "terminal:history":
      handleTerminalHistory(ctx, msg);
      break;
    case "terminal:unwatch":
      handleTerminalUnwatch(ctx, msg);
      break;
    case "terminal:resize":
      handleTerminalResize(ctx, msg);
      break;
    case "workspace:read":
      handleWorkspaceRead(ctx, msg);
      break;
    case "interrupt:dismiss":
      // 批次 C（P1.4）：web 审批面驳回——删本地 pending 记录（resumeToken
      // 随记录一并作废）；store.delete 触发 onChange → 回推新快照。
      if (msg.agentId && msg.conversationId) {
        try {
          ctx.runtime.__getInterruptStore().delete(msg.agentId, msg.conversationId);
        } catch (err) {
          console.warn(`[Daemon] interrupt dismiss failed: ${(err as Error)?.message}`);
        }
      }
      break;
    case "ping":
      handlePing(ctx);
      break;
    case "connected":
      break;
  }
}
