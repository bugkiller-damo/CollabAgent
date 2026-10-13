import type { PendingInterruptSummary } from "@collabagent/shared";
import { describe, expect, it } from "vitest";
import { buildDecision, buildResolveFrame, decisionButtons } from "./interrupt-decisions";

const base: PendingInterruptSummary = {
  agentId: "aaaaaaaa-1111-1111-1111-111111111111",
  conversationId: "slock:v1:x:channel:general",
  interruptId: "int-1",
  prompt: "批准执行吗？",
  createdAt: 1,
  expiresAt: 2,
};

describe("decisionButtons（WP10：审批决定按钮投影）", () => {
  it("edit 不渲染：声明含 edit 时只投影 approve/reject/respond", () => {
    const d = decisionButtons({
      ...base,
      options: { decisions: ["approve", "reject", "respond", "edit"] },
    });
    expect(d.map((x) => x.type)).toEqual(["approve", "reject", "respond"]);
  });

  it("未声明的骨架决定被过滤；worker 顺序不影响固定序", () => {
    const d = decisionButtons({ ...base, options: { decisions: ["respond", "approve"] } });
    expect(d.map((x) => x.type)).toEqual(["approve", "respond"]);
    expect(d.find((x) => x.type === "reject")).toBeUndefined();
    // approve 一键无输入；reject/respond 带输入框
    expect(d.find((x) => x.type === "approve")!.input).toBe(false);
    expect(d.find((x) => x.type === "respond")!.input).toBe(true);
  });

  it("未知枚举值被忽略；仅未知值 → 空数组", () => {
    expect(
      decisionButtons({ ...base, options: { decisions: ["edit", "bogus", "approve"] } }).map((x) => x.type),
    ).toEqual(["approve"]);
    expect(decisionButtons({ ...base, options: { decisions: ["edit", "bogus"] } })).toEqual([]);
  });

  it("无 decisions 声明 → 空数组（退回旧交互：文本回复 + 驳回）", () => {
    expect(decisionButtons(base)).toEqual([]);
    expect(decisionButtons({ ...base, options: {} })).toEqual([]);
    expect(decisionButtons({ ...base, options: { actions: [{ name: "deploy", argsPreview: "{}" }] } })).toEqual([]);
  });
});

describe("buildDecision（UI 态 → SarpResumeDecision）", () => {
  it("approve 忽略文本直出 {type:'approve'}", () => {
    expect(buildDecision("approve", "anything")).toEqual({ type: "approve" });
  });

  it("reject 文本可缺省；带文本时写入 message（trim）", () => {
    expect(buildDecision("reject", "")).toEqual({ type: "reject" });
    expect(buildDecision("reject", "  先别动  ")).toEqual({ type: "reject", message: "先别动" });
  });

  it("respond 必填：空文本 → null（不发半个决定）", () => {
    expect(buildDecision("respond", "   ")).toBeNull();
    expect(buildDecision("respond", " 用 GET 就行 ")).toEqual({ type: "respond", message: "用 GET 就行" });
  });
});

describe("buildResolveFrame（browser → server 帧）", () => {
  it("身份三元组 + decision；不带 approver（server 注入）", () => {
    const f = buildResolveFrame(base, { type: "respond", message: "hi" });
    expect(f).toEqual({
      type: "interrupt:resolve",
      agentId: base.agentId,
      conversationId: base.conversationId,
      interruptId: base.interruptId,
      decision: { type: "respond", message: "hi" },
    });
    expect(f).not.toHaveProperty("approver");
    // 安全摘要永不带出 resumeToken
    expect(JSON.stringify(f)).not.toContain("resumeToken");
  });
});
