import { describe, expect, it } from "vitest";
import { asClaudeStreamEvent } from "../src/claude-stream.js";
import { errMessage } from "../src/errors.js";
import { parseWsToDaemonMessage, readDeliverMessage } from "../src/handlers/inbound.js";

describe("claude-stream asClaudeStreamEvent", () => {
  it("recognizes the four known types", () => {
    expect(asClaudeStreamEvent({ type: "system", subtype: "init", session_id: "s" })?.type).toBe("system");
    expect(asClaudeStreamEvent({ type: "assistant", message: { id: "m" } })?.type).toBe("assistant");
    expect(asClaudeStreamEvent({ type: "user" })?.type).toBe("user");
    expect(asClaudeStreamEvent({ type: "result", total_cost_usd: 0.1 })?.type).toBe("result");
  });

  it("returns null for unknown / non-object", () => {
    expect(asClaudeStreamEvent(null)).toBeNull();
    expect(asClaudeStreamEvent("x")).toBeNull();
    expect(asClaudeStreamEvent({ type: "mystery" })).toBeNull();
    expect(asClaudeStreamEvent({ foo: 1 })).toBeNull();
  });
});

describe("parseWsToDaemonMessage", () => {
  it("normalizes agent:deliver thread_id snake_case + flat payload", () => {
    const msg = parseWsToDaemonMessage({
      type: "agent:deliver",
      content: "hi",
      channelId: "#ops",
      thread_id: "abcdef123456",
      senderName: "bob",
      mentionAgents: ["alice"],
    });
    expect(msg).toMatchObject({
      type: "agent:deliver",
      message: {
        content: "hi",
        channelId: "#ops",
        threadId: "abcdef123456",
        senderName: "bob",
        mentionAgents: ["alice"],
      },
    });
  });

  it("keeps mentionAgents absent vs empty distinct", () => {
    const withField = parseWsToDaemonMessage({
      type: "agent:deliver",
      message: { content: "x", mentionAgents: [] },
    });
    expect(withField && withField.type === "agent:deliver" && withField.message.mentionAgents).toEqual([]);

    const without = parseWsToDaemonMessage({ type: "agent:deliver", message: { content: "x" } });
    expect(without && without.type === "agent:deliver" && without.message.mentionAgents).toBeUndefined();
  });

  it("normalizes agent:start three variants", () => {
    const agent = parseWsToDaemonMessage({
      type: "agent:start",
      agent: { id: "id-1", name: "alice", model: "sonnet" },
    });
    expect(agent).toMatchObject({
      type: "agent:start",
      agent: { id: "id-1", name: "alice", model: "sonnet" },
    });

    const config = parseWsToDaemonMessage({
      type: "agent:start",
      config: { name: "alice", runtime_profile: { model: "haiku" } },
    });
    expect(config).toMatchObject({
      type: "agent:start",
      config: { name: "alice", runtime_profile: { model: "haiku" } },
    });
  });

  it("Phase 1：agent:start 归一化 runtime/entrypoint/runtime_profile 字段", () => {
    const msg = parseWsToDaemonMessage({
      type: "agent:start",
      agent: { id: "id-1", name: "alice", runtime: "langgraph", entrypoint: "ep-1" },
      config: { runtime_profile: { runtime: "langgraph", model: "gpt-4o", entrypoint: "ep-1" } },
    });
    expect(msg).toMatchObject({
      type: "agent:start",
      agent: { id: "id-1", name: "alice", runtime: "langgraph", entrypoint: "ep-1" },
      config: { runtime_profile: { runtime: "langgraph", model: "gpt-4o", entrypoint: "ep-1" } },
    });
    // 非字符串字段不静默过关
    const bad = parseWsToDaemonMessage({
      type: "agent:start",
      config: { name: "a", runtime: 42, entrypoint: ["x"], runtime_profile: "str" },
    });
    expect(bad && bad.type === "agent:start" && bad.config?.runtime).toBeUndefined();
    expect(bad && bad.type === "agent:start" && bad.config?.entrypoint).toBeUndefined();
    expect(bad && bad.type === "agent:start" && bad.config?.runtime_profile).toBeUndefined();
  });

  it("parses reminder.fire / agent:duty / ping; drops unknown type", () => {
    expect(
      parseWsToDaemonMessage({
        type: "reminder.fire",
        agentId: "a",
        reminder: { title: "巡检", kind: "patrol", channel: "#ops" },
      }),
    ).toMatchObject({
      type: "reminder.fire",
      agentId: "a",
      reminder: { title: "巡检", kind: "patrol", channel: "#ops" },
    });
    expect(parseWsToDaemonMessage({ type: "agent:duty", name: "alice", duty: "off" })).toMatchObject({
      type: "agent:duty",
      name: "alice",
      duty: "off",
    });
    expect(parseWsToDaemonMessage({ type: "ping" })).toEqual({ type: "ping" });
    expect(parseWsToDaemonMessage({ type: "nope" })).toBeNull();
    expect(parseWsToDaemonMessage(null)).toBeNull();
  });

  it("readDeliverMessage prefers nested message over top-level", () => {
    const m = readDeliverMessage({
      content: "outer",
      message: { content: "inner", channelId: "#g" },
    });
    expect(m.content).toBe("inner");
    expect(m.channelId).toBe("#g");
  });

  it("F6/F8：透传 attachments（filename 直通 + url 收口必填），畸形项丢弃", () => {
    const m = readDeliverMessage({
      type: "agent:deliver",
      message: {
        content: "see file",
        attachments: [
          {
            id: "a1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2048,
            url: "/api/attachments/a1",
          },
          { id: "a2", name: "legacy.txt", mimeType: "text/plain", sizeBytes: 5 }, // 旧载荷 name 兜底；url 缺省 → ""
          { filename: "no-id.png" }, // 缺 id → 丢弃
          "garbage", // 非对象 → 丢弃
        ],
      },
    });
    expect(m.attachments).toEqual([
      { id: "a1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048, url: "/api/attachments/a1" },
      { id: "a2", filename: "legacy.txt", mimeType: "text/plain", sizeBytes: 5, url: "" },
    ]);
  });

  it("F6：attachments 缺失 / 空数组 / 全畸形 → undefined", () => {
    expect(readDeliverMessage({ message: { content: "x" } }).attachments).toBeUndefined();
    expect(readDeliverMessage({ message: { content: "x", attachments: [] } }).attachments).toBeUndefined();
    expect(readDeliverMessage({ message: { content: "x", attachments: [{ nope: 1 }] } }).attachments).toBeUndefined();
  });
});

describe("errMessage", () => {
  it("pulls Error.message and stringifies the rest", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
    expect(errMessage("x")).toBe("x");
    expect(errMessage(12)).toBe("12");
  });
});
