import { agentListFields, composePresence, parseAgentDuty, presenceIsOnline } from "@collabagent/shared";
import { describe, expect, it } from "vitest";

describe("composePresence", () => {
  it("停班压过计算机在线和运行时", () => {
    expect(composePresence("off", true, "working")).toBe("off_duty");
    expect(composePresence("off", false, "idle")).toBe("off_duty");
  });

  it("值班但办公室关门 → computer_offline", () => {
    expect(composePresence("on", false, "working")).toBe("computer_offline");
  });

  it("值班且开门：working / starting 透传", () => {
    expect(composePresence("on", true, "working")).toBe("working");
    expect(composePresence("on", true, "starting")).toBe("starting");
  });

  it("进程回收 stopped 仍显示 idle", () => {
    expect(composePresence("on", true, "stopped")).toBe("idle");
    expect(composePresence("on", true, "idle")).toBe("idle");
    expect(composePresence("on", true)).toBe("idle");
  });

  it("非法 / 缺省 duty 视为 on", () => {
    expect(parseAgentDuty("nope")).toBe("on");
    expect(parseAgentDuty(undefined)).toBe("on");
    expect(composePresence(undefined, true)).toBe("idle");
  });

  it("isOnline 仅 idle/starting/working", () => {
    expect(presenceIsOnline("idle")).toBe(true);
    expect(presenceIsOnline("off_duty")).toBe(false);
    expect(presenceIsOnline("computer_offline")).toBe(false);
    expect(agentListFields("off", true, "working")).toEqual({
      duty: "off",
      presence: "off_duty",
      isOnline: false,
    });
  });
});
