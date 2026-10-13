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

describe("WP7 — toSarpTurnMessage 结构化透传（mention / DM / forceDeliverTo）", () => {
  it("mention 路径：runAgent 末位参数 = 结构化 message（原文 text，不带附件摘要）", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m10",
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
    // runAgent(name, channel, target, sender, contentForAgent, threadId, messageId, message)
    const msg = calls.runAgent[0][7];
    expect(msg).toEqual({
      text: "看下这个", // 原始 m.content——不含 [附件 1] 摘要行
      sender: "bob",
      messageId: "m10",
      attachments: [
        { id: "a1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048, url: "/api/attachments/a1" },
      ],
    });
    // prompt 侧仍带摘要——结构化与文本通道并存互不替代
    expect(calls.runAgent[0][4]).toContain("[附件 1]");
    expect(msg.text).not.toContain("[附件 1]");
  });

  it("DM 路径：runAgentDm 末位参数同样带结构化 message", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m11",
        channelId: "dm:chan-1",
        senderId: "u-human",
        senderName: "bob",
        senderHandle: "bob",
        senderType: "human",
        content: "私信内容",
        time: "2026-09-16T00:00:00Z",
        dm: true,
        dmAgentRecipients: ["alice"],
        attachments: [ATT],
      }),
    );
    expect(calls.runAgentDm).toHaveLength(1);
    // runAgentDm(name, replyTarget, senderHandle, contentForAgent, message)
    expect(calls.runAgentDm[0][4]).toEqual({
      text: "私信内容",
      sender: "bob",
      messageId: "m11",
      attachments: [
        { id: "a1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048, url: "/api/attachments/a1" },
      ],
    });
  });

  it("forceDeliverTo 路径：结构化 message 同样透传", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m12",
        channelId: "#general",
        senderId: "u-sys",
        senderName: "system",
        senderType: "agent", // forceDeliverTo 绕开防自环——仍带结构化原文
        content: "派单",
        time: "2026-09-16T00:00:00Z",
        forceDeliverTo: "alice",
      }),
    );
    expect(calls.runAgent).toHaveLength(1);
    expect(calls.runAgent[0][7]).toEqual({ text: "派单", sender: "system", messageId: "m12" });
  });

  it("无 url 附件：不凭空构造 url 键；附件-only 时 text 为空串", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m13",
        channelId: "#general",
        senderId: "u-human",
        senderName: "bob",
        senderType: "human",
        content: "",
        time: "2026-09-16T00:00:00Z",
        attachments: [{ id: "a9", filename: "no-url.bin", mimeType: "application/octet-stream", sizeBytes: 7 }],
        mentionAgents: ["alice"],
      }),
    );
    const msg = calls.runAgent[0][7];
    expect(msg.text).toBe("");
    expect(msg.attachments).toEqual([
      { id: "a9", filename: "no-url.bin", mimeType: "application/octet-stream", sizeBytes: 7 },
    ]);
    expect("url" in msg.attachments[0]).toBe(false);
  });

  it("triage 路径不带结构化 message（runAgentTriage 签名无此参数）", async () => {
    const { ctx, calls } = makeCtx();
    await handleAgentDeliver(
      ctx,
      deliverMsg({
        id: "m14",
        channelId: "#general",
        senderId: "u-human",
        senderName: "bob",
        senderType: "human",
        content: "谁能看下",
        time: "2026-09-16T00:00:00Z",
        triageAgents: ["alice"], // mentionAgents 缺省 → 本地解析也无命中 → 落 triage
      }),
    );
    expect(calls.runAgentTriage).toHaveLength(1);
    expect(calls.runAgentTriage[0].length).toBe(7); // (name, channel, target, sender, content, threadId, messageId)
  });
});
