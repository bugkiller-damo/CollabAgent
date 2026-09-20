import { describe, expect, it } from "vitest";
import { buildTriagePrompt, pickLocalTriageAgent } from "../src/agent-runtime-dispatch.js";
import { buildRoleContextLine } from "../src/agent-startup.js";
import { generateSystemPrompt } from "../src/system-prompt.js";

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

// A1.3：dispatchContext 确定性事实 —— 回合语境行（dispatchHeadlessTurn 每回合追加）
// 与系统提示（spawn 时写入）两处都要带经理/worker 身份，不再是「如果你是经理…」条件句。
// A3 起系统提示去频道化：频道名/可派发名单只在回合语境行，系统提示只留角色语义。
describe("A1.3 角色语境（经理/worker 确定性事实）", () => {
  it("经理回合语境行含可派发名单", () => {
    const line = buildRoleContextLine("alerts", { isManager: true, otherAgents: ["worker-a", "worker-b"] });
    expect(line).toContain("#alerts");
    expect(line).toContain("经理");
    expect(line).toContain("dispatch_task");
    expect(line).toContain("@worker-a");
    expect(line).toContain("@worker-b");
  });

  it("worker 回合语境行声明非经理", () => {
    const line = buildRoleContextLine("alerts", { isManager: false, otherAgents: ["boss"] });
    expect(line).toContain("不是经理");
    expect(line).toContain("dispatch_task");
  });

  it("经理系统提示声明经理身份（频道/名单下沉到回合语境行，不进系统提示）", () => {
    const p = generateSystemPrompt({ name: "boss" }, { isManager: true, otherAgents: ["worker-a"] });
    expect(p).toContain("你在频道里担任经理");
    expect(p).toContain("dispatch_task");
    expect(p).toContain("【本回合语境】");
    // 去频道化（§8.5）：spawn 时写死的频道名/名单不得出现在系统提示里
    expect(p).not.toContain("#alerts");
    expect(p).not.toContain("@worker-a");
  });

  it("worker 系统提示含「你不是经理」", () => {
    const p = generateSystemPrompt({ name: "w" }, { isManager: false, otherAgents: ["boss"] });
    expect(p).toContain("不是");
    expect(p).toContain("经理");
    expect(p).toContain("dispatch_task");
  });
});
