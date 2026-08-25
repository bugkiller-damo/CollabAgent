import type { WsToDaemonMessage } from "@collabagent/shared";
import { handleAgentDuty, handleAgentStart, handleAgentStop } from "./agent.js";
import { handleAgentDeliver } from "./deliver.js";
import { handlePing } from "./ping.js";
import { handleReminderFire } from "./reminder.js";
import { handleTerminalHistory, handleTerminalResize, handleTerminalUnwatch, handleTerminalWatch } from "./terminal.js";
import type { HandlerContext } from "./types.js";
import { handleWorkspaceRead } from "./workspace.js";

export type { HandlerContext } from "./types.js";

export async function dispatchDaemonMessage(ctx: HandlerContext, msgWire: WsToDaemonMessage): Promise<void> {
  // 接收体保留防御性解析：线协议有松散变体（thread_id 蛇形、msg.message||msg
  // 双路径、agent:start 三种变体），规范类型约束在发送侧生效（sendWs）。
  const msg = msgWire as Record<string, unknown>;
  const type = msg.type as string | undefined;
  switch (type) {
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
  }
}
