import { pickLocalTriageAgent } from "../agent-runtime-dispatch.js";
import type { HandlerContext } from "./types.js";

function parseDeliverChannel(m: Record<string, unknown>): {
  channelName: string;
  threadId: string;
  replyTarget: string;
  senderName: string;
} {
  const rawChannel = (m.channelId as string) || "general";
  const channelName = rawChannel.replace(/^#/, "").split(":")[0];
  const threadId = (m.threadId as string) || (m.thread_id as string) || "";
  const replyTarget = threadId ? `#${channelName}:${threadId.slice(0, 8)}` : `#${channelName}`;
  const senderName = (m.senderName as string) || (m.senderId as string) || "unknown";
  return { channelName, threadId, replyTarget, senderName };
}

export async function handleAgentDeliver(ctx: HandlerContext, msg: Record<string, unknown>): Promise<void> {
  const m = (msg.message || msg) as Record<string, unknown>;
  const content = m.content as string;
  if (!content || typeof content !== "string") return;
  if (content.startsWith("🤖 ")) return;

  // 经理/worker 任务派发通知（agents-dispatch.ts 插入的消息）：sender_type
  // 本来就是 'agent'，会被下面的防自环判断挡掉——用一个显式的 forceDeliverTo
  // 字段（携带目标 agent 的 handle）绕开那个判断，直接路由过去。没有这个
  // 字段的普通 agent 消息仍然照旧被挡，不会打开新的自环口子。
  const forceTarget = m.forceDeliverTo as string | undefined;
  if (forceTarget) {
    if (ctx.runtime.hasAgent(forceTarget)) {
      const { channelName, threadId, replyTarget, senderName } = parseDeliverChannel(m);
      console.log(`[Daemon] Dispatch message for @${forceTarget} in ${replyTarget}: ${content.slice(0, 50)}`);
      try {
        await ctx.runtime.runAgent(
          forceTarget,
          channelName,
          replyTarget,
          senderName,
          content,
          threadId || undefined,
          typeof m.id === "string" ? m.id : undefined,
        );
      } catch (err: any) {
        console.error("[Daemon] Dispatch routing failed:", err?.message);
      }
    }
    return;
  }

  if (m.senderType === "agent") return;

  if (m.dm) {
    const recipients = (m.dmAgentRecipients as string[]) || [];
    const senderHandle = (m.senderHandle as string) || (m.senderName as string) || "unknown";
    const replyTarget = `dm:@${senderHandle}`;
    for (const name of recipients) {
      if (!ctx.runtime.hasAgent(name)) continue;
      console.log(`[Daemon] DM -> @${name} (reply ${replyTarget})`);
      try {
        await ctx.runtime.runAgentDm(name, replyTarget, senderHandle, content);
      } catch (err: any) {
        console.error("[Daemon] DM dispatch failed:", err?.message);
      }
    }
    return;
  }

  // server 下发的「有权回应的 agent」列表（messages.ts /send 按频道权限预过滤）：
  // 有字段（含空数组）→ 只 spawn 列表内 agent，私有频道非成员 agent 不会起 PTY，
  // 避免「起了进程、思考半天、回复被 403」的资源浪费；无字段（旧 server）退回本地文本解析。
  const deliverList = m.mentionAgents as string[] | undefined;
  const target = Array.isArray(deliverList)
    ? deliverList.find((n) => ctx.runtime.hasAgent(n))
    : ctx.runtime.findMentionedAgent(content || "");
  const { channelName, threadId, replyTarget, senderName } = parseDeliverChannel(m);

  if (target) {
    console.log(`[Daemon] Message from @${senderName} in ${replyTarget}: ${content?.slice(0, 50)}`);
    if (m.senderId === ctx.agentId || !content || typeof content !== "string") return;
    if (content.startsWith("🤖 ")) return;
    try {
      console.log(`[Daemon] Routing to agent @${target} -> ${replyTarget}`);
      await ctx.runtime.runAgent(
        target,
        channelName,
        replyTarget,
        senderName,
        content,
        threadId || undefined,
        typeof m.id === "string" ? m.id : undefined,
      );
    } catch (err: any) {
      console.error("[Daemon] Failed:", err.message);
    }
    return;
  }

  // T8：mention 未命中后的第四唤醒源——server 单选的分诊经理。
  // 位于 senderType==='agent' / DM / 🤖 拦截之后，agent 消息天然不触发。
  const triageTarget = pickLocalTriageAgent(m.triageAgents, (n) => ctx.runtime.hasAgent(n));
  if (triageTarget) {
    console.log(`[Daemon] Triage for @${triageTarget} in ${replyTarget}: ${content.slice(0, 50)}`);
    try {
      await ctx.runtime.runAgentTriage(
        triageTarget,
        channelName,
        replyTarget,
        senderName,
        content,
        threadId || undefined,
        typeof m.id === "string" ? m.id : undefined,
      );
    } catch (err: any) {
      console.error("[Daemon] Triage routing failed:", err?.message);
    }
  }
}
