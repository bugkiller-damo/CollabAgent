import { describe, expect, it } from "vitest";
import { buildPatrolPrompt } from "../src/agent-runtime-dispatch.js";

// T2 巡检 prompt 模板（设计:docs/2026-08-19/02-t2-agent-patrol-design.md §T2.3）
describe("buildPatrolPrompt", () => {
  it("包含标题与任务指令", () => {
    const p = buildPatrolPrompt({ kind: "patrol", title: "告警巡检", instructions: "读 #alerts 并汇总异常" });
    expect(p).toContain("【定时巡检】告警巡检");
    expect(p).toContain("任务指令：读 #alerts 并汇总异常");
  });

  it("有频道时产出约定带严格 target", () => {
    const p = buildPatrolPrompt({ kind: "patrol", title: "t", channel: "#security" });
    expect(p).toContain("target 严格用该值");
    expect(p).toContain("#security");
    expect(p).toContain("send_message");
  });

  it("无频道时回退 MEMORY.md 约定", () => {
    const p = buildPatrolPrompt({ kind: "patrol", title: "t" });
    expect(p).toContain("MEMORY.md");
  });

  it("沉默协议:无发现直接结束回合、沉默是正常产出、不发确认消息", () => {
    const p = buildPatrolPrompt({ kind: "patrol", title: "t" });
    expect(p).toContain("沉默是正常产出");
    expect(p).toContain("不发任何消息");
    expect(p).toContain("也不要发");
  });

  it("防重复报告:已报告内容不重复", () => {
    const p = buildPatrolPrompt({ kind: "patrol", title: "t" });
    expect(p).toContain("不要重复报告");
  });

  it("防循环放大:明示不要自我续期", () => {
    const p = buildPatrolPrompt({ kind: "patrol", title: "t" });
    expect(p).toContain("不要为延续本任务给自己创建新提醒");
  });

  it("缺省回退:无标题/无指令不产出 undefined", () => {
    const p = buildPatrolPrompt({ kind: "patrol" });
    expect(p).toContain("(未命名任务)");
    expect(p).toContain("(无指令)");
    expect(p).not.toContain("undefined");
  });
});
