/**
 * WP2：bridge runtime（SARP/1 worker）的回合 prompt 模板。
 *
 * 与 Claude 路径的模板（agent-runtime-dispatch.ts 内的 buildPatrolPrompt /
 * buildTriagePrompt / runAgent* 内联文案 + <slock-reminder> 尾巴）平行——
 * 去掉了 Claude 专属约定（slock CLI 兜底、MEMORY.md 引用、「直接打字不会
 * 发出」），代之以平台侧事实：普通消息/私信回合的最终回答由平台自动代发；
 * 分诊/巡检前缀（【频道分诊】/【定时巡检】）保留——回复守卫的 isNudge 探测
 * 依赖它们，这两类回合的最终回答不会被代发。
 *
 * 纯函数，便于单测；不引入运行时依赖。
 */

import type { ReminderFirePayload } from "./agent-runtime-dispatch.js";

export function buildBridgeMessagePrompt(input: {
  channelName: string;
  replyTarget: string;
  senderName: string;
  content: string;
  inThread: boolean;
}): string {
  const headline = input.inThread
    ? `【@${input.senderName} 在 #${input.channelName} 线程中的消息】`
    : `【@${input.senderName} 在 #${input.channelName} 的消息】`;
  return [headline, input.content, ``, `（本会话 target："${input.replyTarget}"）`].join("\n");
}

export function buildBridgeDmPrompt(input: { replyTarget: string; senderName: string; content: string }): string {
  return [`【@${input.senderName} 的私信】`, input.content, ``, `（本会话 target："${input.replyTarget}"）`].join("\n");
}

export function buildBridgePatrolPrompt(reminder: ReminderFirePayload): string {
  const reportWhere = reminder.channel
    ? `用 \`send_message\` 发到 ${reminder.channel}（target 严格用该值）`
    : `用 \`send_message\` 发到合适的会话`;
  return [
    `【定时巡检】${reminder.title || "(未命名任务)"}`,
    ``,
    `任务指令：${reminder.instructions || reminder.title || "(无指令)"}`,
    ``,
    `产出约定：`,
    `- 有值得报告的发现 → ${reportWhere}。`,
    `- 没有值得报告的发现 → 直接结束回合，不发任何消息（沉默是正常产出）；本回合的最终回答不会被自动发送。`,
    `- 之前轮次已经报告过的内容不要重复报告。`,
    `- 不要为延续本任务给自己创建新提醒；调度由系统负责。`,
  ].join("\n");
}

export function buildBridgeReminderPrompt(reminder: ReminderFirePayload): string {
  const where = reminder.channel
    ? `相关会话：${reminder.channel}。需要通知时用 \`send_message\`（target="${reminder.channel}"）。`
    : `没有指定会话；需要通知时用 \`send_message\` 并指定 target。`;
  return [`【提醒触发】${reminder.title || "(无标题)"}`, where, `请据此完成相应跟进。`].join("\n");
}

export function buildBridgeTriagePrompt(input: {
  channelName: string;
  replyTarget: string;
  senderName: string;
  content: string;
}): string {
  return [
    `【频道分诊】#${input.channelName} 来了一条新消息，没有人 @ 任何 agent。`,
    `来自 @${input.senderName}：${input.content}`,
    ``,
    `你是本频道的经理 agent，请判断：`,
    `- 该你处理 → 用 \`send_message\`（target="${input.replyTarget}"）直接回复`,
    `- 该别的 agent 处理 → 用 \`dispatch_task\` 派给合适的成员 agent`,
    `- 无需 agent 介入（人类闲聊/纯围观/与职责无关）→ 直接结束回合，不发任何消息`,
    `本回合的最终回答不会被自动发送。拿不准先读上下文再定；沉默是正常产出。`,
  ].join("\n");
}
