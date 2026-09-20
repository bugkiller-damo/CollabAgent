import { describe, expect, it } from "vitest";
import { buildConversationId, CONVERSATION_ID_PREFIX } from "../src/agent-conversation-id.js";

/**
 * Phase 2：稳定 conversationId（design §11.1）。
 * 纯函数、无随机、跨重启稳定；分类法 thread/channel/dm/triage/reminder。
 */

const base = { agentId: "agent_123", channelName: "research" };

describe("buildConversationId — §11.1 分类法", () => {
  it("线程 → :thread:<threadId>", () => {
    expect(buildConversationId({ ...base, kind: "message", threadId: "th_9" })).toBe(
      `${CONVERSATION_ID_PREFIX}agent_123:thread:th_9`,
    );
  });

  it("顶层频道消息 → :channel:<channel>", () => {
    expect(buildConversationId({ ...base, kind: "message" })).toBe(
      `${CONVERSATION_ID_PREFIX}agent_123:channel:research`,
    );
    expect(buildConversationId({ ...base, kind: "dispatch" })).toBe(
      `${CONVERSATION_ID_PREFIX}agent_123:channel:research`,
    );
    expect(buildConversationId({ ...base, kind: "nudge" })).toBe(`${CONVERSATION_ID_PREFIX}agent_123:channel:research`);
  });

  it("DM → :dm:<peer>", () => {
    expect(buildConversationId({ ...base, kind: "message", channelName: "dm:alice" })).toBe(
      `${CONVERSATION_ID_PREFIX}agent_123:dm:alice`,
    );
  });

  it("triage / reminder → 独立桶", () => {
    expect(buildConversationId({ ...base, kind: "triage" })).toBe(`${CONVERSATION_ID_PREFIX}agent_123:triage:research`);
    expect(buildConversationId({ ...base, kind: "reminder", sourceId: "rem_1" })).toBe(
      `${CONVERSATION_ID_PREFIX}agent_123:reminder:rem_1`,
    );
    // reminder 无 sourceId 时退化为频道桶——确定性不丢
    expect(buildConversationId({ ...base, kind: "reminder" })).toContain(":reminder:");
  });

  it("稳定性：同输入恒等；CJK/特殊字符折叠为 _", () => {
    const a = buildConversationId({ ...base, threadId: "th-9" });
    const b = buildConversationId({ ...base, threadId: "th-9" });
    expect(a).toBe(b);
    const c = buildConversationId({ ...base, channelName: "研发 频道#1" });
    // CJK 折叠为 _ 后剥边，数字 1 保留 → "1"
    expect(c).toBe(`${CONVERSATION_ID_PREFIX}agent_123:channel:1`);
    expect(c).toMatch(/^[\x20-\x7e]+$/); // ASCII 可引述
  });

  it("超长 → 截断为 头~sha256 尾", () => {
    const id = buildConversationId({ ...base, threadId: "t".repeat(400) });
    expect(id.length).toBeLessThan(280);
    expect(id).toMatch(/~[0-9a-f]{16}$/);
  });
});
