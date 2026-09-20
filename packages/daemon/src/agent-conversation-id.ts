/**
 * Phase 2：稳定 conversationId 生成（设计 §11.1）。
 *
 * 会话身份与进程生命周期解耦：同一个 (agent, conversation) 的多次回合复用同一
 * conversationId，LangGraph worker 把它映射成 thread_id 接 checkpoint——
 * daemon 重启 / worker 换进程后 thread 仍能续上，不绑 Claude 式 session_id。
 *
 * 分类法（§11.1.2）：
 *   频道线程          → slock:v1:<agentId>:thread:<threadId>
 *   频道顶层          → slock:v1:<agentId>:channel:<channelName>
 *   DM                → slock:v1:<agentId>:dm:<peer>
 *   分诊（triage）    → slock:v1:<agentId>:triage:<channelName>
 *   提醒（reminder）  → slock:v1:<agentId>:reminder:<reminderId>
 *   dispatch/nudge    → 跟随其频道/线程上下文（同 message 规则）
 *
 * 稳定性要求（§11.1.3）：
 * - daemon 重启不变（纯函数，无随机成分）；
 * - 线程置顶/频道改名不重置 thread 会话（用 ID 而非显示名——channelName
 *   本身是稳定 slug，改名沿用同一会话语义可接受）；
 * - 编码只做安全过滤，超长按 sha256 截断（§11.1.4）。
 */

import { createHash } from "node:crypto";
import type { DispatchKind } from "./agent-dispatch-queue.js";

export const CONVERSATION_ID_PREFIX = "slock:v1:";
/** 超长 ID 截断阈值（§11.1.4：>256 bytes 走 sha256 摘要） */
const MAX_CONVERSATION_ID_BYTES = 256;

/** 段内允许字符：字母数字与 . _ : -；其余折叠为 _（含 CJK——保持 ID ASCII 可引述） */
const sanitizeSegment = (s: string): string =>
  s
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "_";

const capLength = (id: string): string => {
  if (Buffer.byteLength(id, "utf-8") <= MAX_CONVERSATION_ID_BYTES) return id;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  // 保留可读前缀 + 摘要尾巴（截断在 ASCII 边界，sanitize 后段内无多字节字符）
  const head = id.slice(0, 200).replace(/[^A-Za-z0-9._:-].*$/, "");
  return `${head}~${digest}`;
};

export interface ConversationInput {
  agentId: string;
  kind: DispatchKind;
  channelName: string;
  threadId?: string;
  /** reminder 的稳定 ID（ReminderFirePayload.id）——其它 kind 不用 */
  sourceId?: string;
}

/**
 * 生成稳定 conversationId。agentId 为空时退化为 agentName 维度不会发生——
 * 调用方（doDispatch）在无 agentId 时早已 agent-unknown 死信，这里对空 id
 * 仍返回确定结果（"_" 段），不抛错。
 */
export const buildConversationId = (input: ConversationInput): string => {
  const agent = sanitizeSegment(input.agentId);
  const channel = sanitizeSegment(input.channelName);
  const parts = [CONVERSATION_ID_PREFIX, agent];

  if (input.threadId) {
    parts.push(":thread:", sanitizeSegment(input.threadId));
  } else if (input.channelName.startsWith("dm:")) {
    parts.push(":dm:", sanitizeSegment(input.channelName.slice(3)));
  } else if (input.kind === "triage") {
    parts.push(":triage:", channel);
  } else if (input.kind === "reminder") {
    // 无稳定 reminder id 时退回频道桶（sourceId 可能为 ""——WS schema 缺省，
    // 不当真值处理；sanitize 空段也会得 "_"，但语义上应归频道桶）
    parts.push(":reminder:", sanitizeSegment(input.sourceId || channel));
  } else {
    // message / dispatch / nudge：跟随频道上下文（顶层消息会话）
    parts.push(":channel:", channel);
  }
  return capLength(parts.join(""));
};
