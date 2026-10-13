import { describe, expect, it } from "vitest";
import {
  buildBridgeDmPrompt,
  buildBridgeMessagePrompt,
  buildBridgePatrolPrompt,
  buildBridgeReminderPrompt,
  buildBridgeTriagePrompt,
} from "../src/bridge-turn-prompt.js";

/**
 * WP2：bridge（SARP/1 worker）回合 prompt 模板——不含 Claude 专属约定
 *（slock CLI 兜底、MEMORY.md、<slock-reminder>、deliverables 目录），
 * 同时保留回复守卫 isNudge 依赖的【定时巡检】/【频道分诊】前缀。
 */

const CLAUDE_ONLY = ["MEMORY.md", "slock message send", "mcp__slock__", "<slock-reminder>", "deliverables"];

const expectNoClaudeArtifacts = (text: string): void => {
  for (const marker of CLAUDE_ONLY) expect(text, `prompt should not contain ${marker}`).not.toContain(marker);
};

describe("buildBridgeMessagePrompt", () => {
  it("顶层消息：发送者 + 频道 + 原文 + target 行", () => {
    const p = buildBridgeMessagePrompt({
      channelName: "general",
      replyTarget: "#general",
      senderName: "bob",
      content: "帮我看下这个报错",
      inThread: false,
    });
    expect(p).toContain("【@bob 在 #general 的消息】");
    expect(p).toContain("帮我看下这个报错");
    expect(p).toContain('（本会话 target："#general"）');
    expectNoClaudeArtifacts(p);
  });

  it("线程消息：headline 标注线程内", () => {
    const p = buildBridgeMessagePrompt({
      channelName: "general",
      replyTarget: "#general:thread-1",
      senderName: "alice",
      content: "跟进",
      inThread: true,
    });
    expect(p).toContain("【@alice 在 #general 线程中的消息】");
    expect(p).toContain('（本会话 target："#general:thread-1"）');
    expectNoClaudeArtifacts(p);
  });
});

describe("buildBridgeDmPrompt", () => {
  it("私信：发送者 + 原文 + dm target 行", () => {
    const p = buildBridgeDmPrompt({ replyTarget: "dm:@bob", senderName: "bob", content: "私下问下进度" });
    expect(p).toContain("【@bob 的私信】");
    expect(p).toContain("私下问下进度");
    expect(p).toContain('（本会话 target："dm:@bob"）');
    expectNoClaudeArtifacts(p);
  });
});

describe("buildBridgePatrolPrompt", () => {
  it("有 channel：【定时巡检】前缀 + target 严格用该值 + 沉默协议", () => {
    const p = buildBridgePatrolPrompt({
      title: "日报巡检",
      instructions: "检查昨天的失败任务",
      channel: "#ops",
      kind: "patrol",
    });
    expect(p.startsWith("【定时巡检】")).toBe(true);
    expect(p).toContain("日报巡检");
    expect(p).toContain("任务指令：检查昨天的失败任务");
    expect(p).toContain("用 `send_message` 发到 #ops（target 严格用该值）");
    expect(p).toContain("沉默是正常产出");
    expect(p).toContain("本回合的最终回答不会被自动发送");
    expectNoClaudeArtifacts(p);
  });

  it("无 channel：退回「发到合适的会话」", () => {
    const p = buildBridgePatrolPrompt({ kind: "patrol" });
    expect(p.startsWith("【定时巡检】(未命名任务)")).toBe(true);
    expect(p).toContain("任务指令：(无指令)");
    expect(p).toContain("用 `send_message` 发到合适的会话");
    expectNoClaudeArtifacts(p);
  });
});

describe("buildBridgeReminderPrompt", () => {
  it("有 channel：【提醒触发】+ target 指定", () => {
    const p = buildBridgeReminderPrompt({ title: "喝水", channel: "#general" });
    expect(p).toContain("【提醒触发】喝水");
    expect(p).toContain('相关会话：#general。需要通知时用 `send_message`（target="#general"）。');
    expectNoClaudeArtifacts(p);
  });

  it("无 channel：说明需自行指定 target", () => {
    const p = buildBridgeReminderPrompt({});
    expect(p).toContain("【提醒触发】(无标题)");
    expect(p).toContain("没有指定会话");
    expect(p).toContain("用 `send_message` 并指定 target");
    expectNoClaudeArtifacts(p);
  });
});

describe("buildBridgeTriagePrompt", () => {
  it("【频道分诊】前缀 + 三分支 + 不自动发送声明", () => {
    const p = buildBridgeTriagePrompt({
      channelName: "general",
      replyTarget: "#general",
      senderName: "carol",
      content: "谁能看下这个？",
    });
    expect(p).toContain("【频道分诊】#general 来了一条新消息");
    expect(p).toContain("来自 @carol：谁能看下这个？");
    expect(p).toContain('`send_message`（target="#general"）');
    expect(p).toContain("`dispatch_task`");
    expect(p).toContain("本回合的最终回答不会被自动发送");
    expectNoClaudeArtifacts(p);
  });
});
