import type { WsToDaemonMessage } from "@collabagent/shared";
import type { HandlerContext } from "./types.js";

type StartMsg = Extract<WsToDaemonMessage, { type: "agent:start" }>;
type StopMsg = Extract<WsToDaemonMessage, { type: "agent:stop" }>;
type DutyMsg = Extract<WsToDaemonMessage, { type: "agent:duty" }>;

export function handleAgentStart(ctx: HandlerContext, msg: StartMsg): void {
  const agent = msg.agent;
  const config = msg.config ?? {};
  const agentId = agent?.id || msg.agentId || "";
  const agentName = agent?.name || config.name || "";
  const displayName = agent?.displayName || config.displayName || agentName;
  const description = agent?.description || config.description || "";
  // runtime_profile.model（Web 端可选 sonnet/opus/haiku）——注册时带上，spawn 拼 --model。
  // 三种推送变体：创建时 model 在 agent.model；编辑（PATCH）时在 config.model；
  // 部分路径在 config.runtime_profile.model。三个位置都兜底。
  const rp = config.runtime_profile ?? agent?.runtime_profile;
  const model = agent?.model || config.model || rp?.model || undefined;
  if (!agentName) {
    console.log("[Daemon] agent:start without name, ignored");
    return;
  }
  ctx.runtime.registerAgent(agentId, agentName, { displayName, description, model });
}

export function handleAgentStop(ctx: HandlerContext, msg: StopMsg): void {
  const stoppedName = ctx.runtime.resolveAgentName(msg.agentId);
  if (stoppedName) ctx.runtime.unregisterAgent(stoppedName);
}

export function handleAgentDuty(ctx: HandlerContext, msg: DutyMsg): void {
  const dutyName = msg.name || ctx.runtime.resolveAgentName(msg.agentId) || "";
  if (!dutyName) {
    console.log("[Daemon] agent:duty without name, ignored");
    return;
  }
  if (msg.duty === "off") {
    console.log(`[Daemon] @${dutyName} off duty — unregister`);
    ctx.runtime.unregisterAgent(dutyName);
  } else {
    const dutyId = msg.agentId || ctx.runtime.resolveAgentId(dutyName) || "";
    const info = ctx.runtime.getAgentInfo(dutyName) || {};
    console.log(`[Daemon] @${dutyName} on duty — register (lazy)`);
    ctx.runtime.registerAgent(dutyId, dutyName, info);
  }
}
