import type { WsAgentStartConfig, WsToDaemonMessage } from "@collabagent/shared";
import type { AgentRegistrationInfo, RuntimeProfileIssue } from "../agent-runtime-profile.js";
import type { HandlerContext } from "./types.js";

type StartMsg = Extract<WsToDaemonMessage, { type: "agent:start" }>;
type StopMsg = Extract<WsToDaemonMessage, { type: "agent:stop" }>;
type DutyMsg = Extract<WsToDaemonMessage, { type: "agent:duty" }>;

export function handleAgentStart(ctx: HandlerContext, msg: StartMsg): void {
  const agent = msg.agent;
  const config: WsAgentStartConfig = msg.config ?? {};
  const agentId = agent?.id || msg.agentId || "";
  const agentName = agent?.name || config.name || "";
  const displayName = agent?.displayName || config.displayName || agentName;
  const description = agent?.description || config.description || "";
  const runtimeCandidates = [
    config.runtime_profile?.runtime,
    agent?.runtime_profile?.runtime,
    config.runtime,
    agent?.runtime,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const entrypointCandidates = [
    config.runtime_profile?.entrypoint,
    agent?.runtime_profile?.entrypoint,
    config.entrypoint,
    agent?.entrypoint,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const runtime = runtimeCandidates[0]?.trim();
  const entrypoint = entrypointCandidates[0]?.trim();
  const model =
    agent?.model || config.model || config.runtime_profile?.model || agent?.runtime_profile?.model || undefined;
  const runtimeValues = new Set(runtimeCandidates.map((value) => value.trim().toLowerCase()));
  const entrypointValues = new Set(entrypointCandidates.map((value) => value.trim()));
  let runtimeProfileError: RuntimeProfileIssue | null = null;
  if (runtimeValues.size > 1) {
    runtimeProfileError = {
      code: "runtime-profile-conflict",
      message: "Runtime profile contains conflicting runtime values",
    };
  } else if (entrypointValues.size > 1) {
    runtimeProfileError = {
      code: "runtime-profile-conflict",
      message: "Runtime profile contains conflicting entrypoint values",
    };
  }
  if (!agentName) {
    console.log("[Daemon] agent:start without name, ignored");
    return;
  }
  const info: AgentRegistrationInfo = { displayName, description, model };
  const profileTouched = runtimeCandidates.length > 0 || entrypointCandidates.length > 0;
  if (runtime !== undefined) info.runtime = runtime;
  if (entrypoint !== undefined) info.entrypoint = entrypoint;
  if (profileTouched) info.runtimeProfileError = runtimeProfileError;
  ctx.runtime.registerAgent(agentId, agentName, info);
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
