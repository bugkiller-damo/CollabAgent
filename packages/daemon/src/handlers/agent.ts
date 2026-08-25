import type { HandlerContext } from "./types.js";

export function handleAgentStart(ctx: HandlerContext, msg: Record<string, unknown>): void {
  const agent = msg.agent as Record<string, unknown> | undefined;
  const config = (msg.config as Record<string, unknown> | undefined) || {};
  const agentId = (agent?.id as string) || (msg.agentId as string) || "";
  const agentName = (agent?.name as string) || (config.name as string) || "";
  const displayName = (agent?.displayName as string) || (config.displayName as string) || agentName;
  const description = (agent?.description as string) || (config.description as string) || "";
  // runtime_profile.model（Web 端可选 sonnet/opus/haiku）——注册时带上，spawn 拼 --model。
  // 三种推送变体：创建时 model 在 agent.model；编辑（PATCH）时在 config.model；
  // 部分路径在 config.runtime_profile.model。三个位置都兜底。
  const rp = (config.runtime_profile ?? agent?.runtime_profile) as { model?: string } | undefined;
  const model = (agent?.model as string) || (config.model as string) || rp?.model || undefined;
  if (!agentName) {
    console.log("[Daemon] agent:start without name, ignored");
    return;
  }
  ctx.runtime.registerAgent(agentId, agentName, { displayName, description, model });
}

export function handleAgentStop(ctx: HandlerContext, msg: Record<string, unknown>): void {
  const stoppedId = msg.agentId as string;
  const stoppedName = ctx.runtime.resolveAgentName(stoppedId);
  if (stoppedName) ctx.runtime.unregisterAgent(stoppedName);
}

export function handleAgentDuty(ctx: HandlerContext, msg: Record<string, unknown>): void {
  const duty = msg.duty as string;
  const dutyName = (msg.name as string) || ctx.runtime.resolveAgentName(msg.agentId as string) || "";
  if (!dutyName) {
    console.log("[Daemon] agent:duty without name, ignored");
    return;
  }
  if (duty === "off") {
    console.log(`[Daemon] @${dutyName} off duty — unregister`);
    ctx.runtime.unregisterAgent(dutyName);
  } else {
    const dutyId = (msg.agentId as string) || ctx.runtime.resolveAgentId(dutyName) || "";
    const info = ctx.runtime.getAgentInfo(dutyName) || {};
    console.log(`[Daemon] @${dutyName} on duty — register (lazy)`);
    ctx.runtime.registerAgent(dutyId, dutyName, info);
  }
}
