/**
 * F6 回归：deliver 消息的附件透传到 agent prompt。
 * - formatAttachmentSummary：纯函数格式化（文件名/MIME/大小/URL）
 * - handleAgentDeliver：附件-only 消息不再被空 content 守卫吞掉；摘要注入
 *   mention/DM 路由的 content；mention 检测只吃原始 content（防文件名撞 agent 名误唤醒）；
 *   agent 发送者带附件照旧被防自环拦截。
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../src/agent-runtime.js";
import { formatAttachmentSummary, handleAgentDeliver } from "../src/handlers/deliver.js";
import type { HandlerContext } from "../src/handlers/types.js";

interface DeliverCalls {
  runAgent: any[][];
  runAgentDm: any[][];
  runAgentTriage: any[][];
  findMentionedAgent: string[];
}

/** 最小 stub：只实现 handleAgentDeliver 触到的方法，调用参数留痕供断言 */
function makeCtx(opts?: { agentId?: string; agents?: string[] }): { ctx: HandlerContext; calls: DeliverCalls } {
  const agents = new Set(opts?.agents ?? ["alice"]);
  const calls: DeliverCalls = { runAgent: [], runAgentDm: [], runAgentTriage: [], findMentionedAgent: [] };
  const runtime = {
    hasAgent: (n: string) => agents.has(n),
    runAgent: async (...args: any[]) => void calls.runAgent.push(args),
    runAgentDm: async (...args: any[]) => void calls.runAgentDm.push(args),
    runAgentTriage: async (...args: any[]) => void calls.runAgentTriage.push(args),
    findMentionedAgent: (content: string) => {
      calls.findMentionedAgent.push(content);
      return null;
    },
  } as unknown as IAgentRuntime;
  return {
    ctx: {
      runtime,
      sendWs: () => {},
      agentId: opts?.agentId ?? "u-sender-other",
      terminalWatchers: new Map(),
      terminalLastFrame: new Map(),
      terminalObsUnsubs: new Map(),
    },
    calls,
  };
}

const ATT = {
  id: "a1",
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  url: "/api/attachments/a1",
};

function deliverMsg(message: Record<string, unknown>) {
  return { type: "agent:deliver", seq: 1, message } as any;
}

describe("formatAttachmentSummary（F6）", () => {
  it("无附件 → 空串", () => {
    expect(formatAttachmentSummary(undefined)).toBe("");
    expect(formatAttachmentSummary([])).toBe("");
  });

  it("逐行输出 文件名（MIME，大小）：URL；缺 url 不挂冒号", () => {
    const s = formatAttachmentSummary([
      ATT,
      { id: "a2", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 512, url: "" },
    ]);
    expect(s).toBe(
      "[附件 1] report.pdf（application/pdf，2.0 KB）：/api/attachments/a1\n" +
        "[附件 2] notes.txt（text/plain，512 B）",
    );
  });
});

describe("handleAgentDeliver 附件透传（F6）", () => {
  it("附件-only 消息（content 为空）不再被吞：mention 列表路由且 prompt 带摘要", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m1",
        channelId: "#general",
        senderId: "u-human",
        senderName: "bob",
        senderType: "human",
        content: "",
        time: "2026-09-16T00:00:00Z",
        attachments: [ATT],
        mentionAgents: ["alice"],
      }),
    );
    expect(calls.runAgent).toHaveLength(1);
    const [agentName, , , , content] = calls.runAgent[0];
    expect(agentName).toBe("alice");
    expect(content).toContain("[附件 1] report.pdf（application/pdf，2.0 KB）：/api/attachments/a1");
  });

  it("空 content 且无附件：照旧丢弃（不路由）", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m2",
        channelId: "#general",
        senderId: "u-human",
        senderName: "bob",
        senderType: "human",
        content: "",
        time: "2026-09-16T00:00:00Z",
        mentionAgents: ["alice"],
      }),
    );
    expect(calls.runAgent).toHaveLength(0);
  });

  it("文本+附件：摘要在原文之后", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m3",
        channelId: "#general",
        senderId: "u-human",
        senderName: "bob",
        senderType: "human",
        content: "看下这个",
        time: "2026-09-16T00:00:00Z",
        attachments: [ATT],
        mentionAgents: ["alice"],
      }),
    );
    expect(calls.runAgent).toHaveLength(1);
    const content = calls.runAgent[0][4] as string;
    expect(content.startsWith("看下这个\n")).toBe(true);
    expect(content).toContain("[附件 1]");
  });

  it("DM 路径：runAgentDm 收到带摘要的 content", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m4",
        channelId: "dm:chan-1",
        senderId: "u-human",
        senderName: "bob",
        senderHandle: "bob",
        senderType: "human",
        content: "",
        time: "2026-09-16T00:00:00Z",
        dm: true,
        dmAgentRecipients: ["alice"],
        attachments: [ATT],
      }),
    );
    expect(calls.runAgentDm).toHaveLength(1);
    expect(calls.runAgentDm[0][0]).toBe("alice");
    expect(calls.runAgentDm[0][3]).toContain("[附件 1] report.pdf");
  });

  it("mention 检测只吃原始 content：附件文件名撞 agent 名不误唤醒", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m5",
        channelId: "#general",
        senderId: "u-human",
        senderName: "bob",
        senderType: "human",
        content: "", // 无 mentionAgents 字段（旧 server）→ 走 findMentionedAgent
        time: "2026-09-16T00:00:00Z",
        attachments: [{ ...ATT, filename: "alice-notes.txt" }],
      }),
    );
    // findMentionedAgent 收到的是原始空串，不是含 "alice" 的附件摘要
    expect(calls.findMentionedAgent).toEqual([""]);
    expect(calls.runAgent).toHaveLength(0);
  });

  it("agent 发送者带附件：照旧被防自环拦截", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m6",
        channelId: "#general",
        senderId: "u-agent",
        senderName: "other-bot",
        senderType: "agent",
        content: "",
        time: "2026-09-16T00:00:00Z",
        attachments: [ATT],
        mentionAgents: ["alice"],
      }),
    );
    expect(calls.runAgent).toHaveLength(0);
  });
});
