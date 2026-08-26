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
    case "ping":
      handlePing(ctx);
      break;
    case "connected":
      break;
  }
}
