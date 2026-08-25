import type { WsFromDaemonMessage } from "@collabagent/shared";
import type { IAgentRuntime } from "../agent-runtime.js";

export interface HandlerContext {
  runtime: IAgentRuntime;
  sendWs: (ev: WsFromDaemonMessage) => void;
  agentId: string;
  terminalWatchers: Map<string, ReturnType<typeof setInterval>>;
  terminalLastFrame: Map<string, string>;
  terminalObsUnsubs: Map<string, () => void>;
}
