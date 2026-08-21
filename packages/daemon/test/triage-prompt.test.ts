import { describe, expect, it } from "vitest";
import { buildTriagePrompt, pickLocalTriageAgent } from "../src/agent-runtime-dispatch.js";

describe("buildTriagePrompt", () => {
  const p = buildTriagePrompt({
    channelName: "alerts",
    replyTarget: "#alerts",
    senderName: "alice",
    content: "接口报错变多了",
  });

  it("包含分诊标题、来源与原文", () => {
    expect(p).toContain("【频道分诊】#alerts");
    expect(p).toContain("@alice");
    expect(p).toContain("接口报错变多了");
  });

  it("三选一：自己回 / 派单 / 沉默", () => {
    expect(p).toContain("send_message");
    expect(p).toContain('target="#alerts"');
    expect(p).toContain("dispatch_task");
    expect(p).toContain("不发任何消息");
  });

  it("沉默协议：沉默是正常产出，不要硬回复", () => {
    expect(p).toContain("沉默是正常产出");
    expect(p).toContain("不要因为");
  });
});

describe("pickLocalTriageAgent", () => {
  const has = (n: string) => n === "经理";

  it("本机托管该经理时返回名字", () => {
    expect(pickLocalTriageAgent(["经理"], has)).toBe("经理");
  });

  it("triageAgents 中无本机托管 agent 时不醒", () => {
    expect(pickLocalTriageAgent(["别人家的经理"], has)).toBeUndefined();
  });

  it("缺字段 / 非数组不醒", () => {
    expect(pickLocalTriageAgent(undefined, has)).toBeUndefined();
    expect(pickLocalTriageAgent("经理", has)).toBeUndefined();
  });
});
