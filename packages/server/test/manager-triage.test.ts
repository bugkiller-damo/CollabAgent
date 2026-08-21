import { describe, expect, it } from "vitest";
import { computeTriageAgents } from "../src/lib/manager-triage.js";

describe("computeTriageAgents (T8)", () => {
  const mgr = { dm: false, threadId: null, enabled: true, managerName: "经理" };

  it("无 @ + 开关开 + 有经理 → 单选经理", () => {
    expect(computeTriageAgents({ ...mgr, mentionAgents: undefined })).toEqual(["经理"]);
  });

  it("@ 了但没命中任何 agent（mentionAgents=[]）→ 含 triageAgents", () => {
    expect(computeTriageAgents({ ...mgr, mentionAgents: [] })).toEqual(["经理"]);
  });

  it("有 @ 命中 agent 时不含（防双重唤醒）", () => {
    expect(computeTriageAgents({ ...mgr, mentionAgents: ["排查工"] })).toBeUndefined();
  });

  it("线程回复不含", () => {
    expect(computeTriageAgents({ ...mgr, threadId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })).toBeUndefined();
  });

  it("开关关不含", () => {
    expect(computeTriageAgents({ ...mgr, enabled: false })).toBeUndefined();
  });

  it("DM 不含", () => {
    expect(computeTriageAgents({ ...mgr, dm: true })).toBeUndefined();
  });

  it("开关开但没有经理 → 不含", () => {
    expect(computeTriageAgents({ ...mgr, managerName: null })).toBeUndefined();
  });
});
