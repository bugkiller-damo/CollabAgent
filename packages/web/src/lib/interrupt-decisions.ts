import type { PendingInterruptSummary, SarpResumeDecision } from "@collabagent/shared";

/**
 * WP10：pending interrupt 审批面的结构化决定辅助（纯函数，Node 环境可测）。
 *
 * 数据源是 PendingInterruptSummary.options.decisions（daemon 白名单重建、
 * server 再白名单剥壳）——浏览器只渲染声明过的决定类型；edit 一期不渲染
 * （UI 留给后续工作包），未知枚举值一律忽略。
 */
export type DecisionKind = "approve" | "reject" | "respond";

export interface DecisionButton {
  type: DecisionKind;
  label: string;
  /** reject/respond 需展开文本输入（reject 原因可选；respond 回复必填） */
  input: boolean;
  placeholder?: string;
}

const BUTTONS: Record<DecisionKind, DecisionButton> = {
  approve: { type: "approve", label: "批准", input: false },
  reject: { type: "reject", label: "拒绝", input: true, placeholder: "拒绝原因（可选）" },
  respond: { type: "respond", label: "回复", input: true, placeholder: "给 agent 的回复（必填）" },
};

const ORDER: DecisionKind[] = ["approve", "reject", "respond"];

/**
 * 该 interrupt 声明的可渲染决定按钮（按 approve→reject→respond 固定序）。
 * 无 options / 无 decisions / 仅 edit 或未知值 → 空数组（退回旧交互：
 * 文本回复即批准 + 驳回）。
 */
export function decisionButtons(i: PendingInterruptSummary): DecisionButton[] {
  const declared = i.options?.decisions;
  if (!Array.isArray(declared)) return [];
  return ORDER.filter((k) => declared.includes(k)).map((k) => BUTTONS[k]);
}

/**
 * UI 态 → SarpResumeDecision。respond 空文本返回 null（必填校验——
 * 空回复没有语义，也比发半个决定安全）。
 */
export function buildDecision(type: DecisionKind, text: string): SarpResumeDecision | null {
  const t = text.trim();
  switch (type) {
    case "approve":
      return { type: "approve" };
    case "reject":
      return t ? { type: "reject", message: t } : { type: "reject" };
    case "respond":
      return t ? { type: "respond", message: t } : null;
  }
}

/**
 * 拼 browser → server 的 interrupt:resolve 帧（server 校验属主 + 注入
 * approver 后路由回托管 daemon；interruptId 防误消费顶替后的旧 pending）。
 */
export function buildResolveFrame(i: PendingInterruptSummary, decision: SarpResumeDecision): Record<string, unknown> {
  return {
    type: "interrupt:resolve",
    agentId: i.agentId,
    conversationId: i.conversationId,
    interruptId: i.interruptId,
    decision,
  };
}
